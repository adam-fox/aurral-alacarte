// Aurral download source for alacarte (https://github.com/norifm/alacarte).
//
// alacarte's integration API downloads one song at a time into its own music
// folder (POST /songs/:id/ensure). For an album, the plugin asks for each
// track, alacarte files them, and Aurral plays them from that folder, which
// must be one of Aurral's read-only folders. No paths cross between the apps.
//
// An ensure request stays open until alacarte has the song, or answers 504
// after 15 minutes while the job is still queued. alacarte keeps one queued
// job per song, so asking again is safe. The plugin keeps at most one request
// open per track and a few across all albums, and records each album's
// progress in dataFolder so a restarted process picks up where it left off.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API = "/api/integration/v1";
const DONE = new Set(["existing", "downloaded"]);

const trimSlashes = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[\\/]+$/, "");

const fold = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Apple names singles and EPs "Title - Single" and "Title - EP".
const plainTitle = (title) =>
  String(title ?? "")
    .replace(/\s+(?:-|–|—)\s+(?:single|ep)\s*$/i, "")
    .trim();

function parallelLimit(settings) {
  const n = Math.floor(Number(settings.parallel));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 3;
}

class AlacarteError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(settings, path, { method = "GET", timeoutMs = 30_000 } = {}) {
  const base = trimSlashes(settings.url);
  let response;
  try {
    response = await fetch(`${base}${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${settings.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new AlacarteError("alacarte took too long to answer", 0);
    throw new AlacarteError(`Couldn't reach alacarte at ${base}`, 0);
  }
  const body = await response.json().catch(() => null);
  if (response.ok) return body;
  if (response.status === 401) throw new AlacarteError("alacarte rejected the integration token", 401);
  if (response.status === 404 && /turned off/.test(body?.error ?? ""))
    throw new AlacarteError("The integration is off in alacarte. Turn it on under Settings > Integrations.", 404);
  if (response.status === 429) throw new AlacarteError("Apple is rate-limiting alacarte; try again later", 429);
  throw new AlacarteError(
    body?.error ? `alacarte answered ${response.status}: ${body.error}` : `alacarte answered ${response.status}`,
    response.status,
  );
}

// ---- progress files ------------------------------------------------------

const stateFile = (dataFolder, id) => join(dataFolder, "downloads", `${id.replace(/[^\w.-]/g, "_")}.json`);

async function loadState(dataFolder, id) {
  try {
    return JSON.parse(await readFile(stateFile(dataFolder, id), "utf8"));
  } catch {
    return null;
  }
}

async function saveState(dataFolder, state) {
  await mkdir(join(dataFolder, "downloads"), { recursive: true });
  await writeFile(stateFile(dataFolder, state.id), JSON.stringify(state));
}

// ---- track requests ------------------------------------------------------
//
// Held in memory: which tracks have a request open, and the ones waiting for
// a free slot. Results land in `results` and are written to the album's
// progress file on its next status call.

const open = new Set(); // "<downloadId>:<trackId>"
const waiting = []; // { key, settings, trackId }
const results = new Map(); // key -> { state, error }
const discarded = new Set(); // downloadIds
let limit = 3;

function pump() {
  while (open.size < limit && waiting.length) {
    const job = waiting.shift();
    const downloadId = job.key.split(":")[0];
    if (discarded.has(downloadId)) continue;
    open.add(job.key);
    ensure(job).finally(() => {
      open.delete(job.key);
      pump();
    });
  }
}

async function ensure({ key, settings, trackId }) {
  try {
    // alacarte gives up waiting after 15 minutes; allow a little longer.
    const out = await call(settings, `/songs/${encodeURIComponent(trackId)}/ensure`, {
      method: "POST",
      timeoutMs: 16 * 60_000,
    });
    results.set(key, DONE.has(out?.status) ? { state: "done" } : { state: "retry" });
  } catch (err) {
    // 504: still queued in alacarte. 0: network trouble or our own timeout.
    // 429: Apple is pacing alacarte. All three are worth asking again.
    // Wait a minute first on the last two, holding the slot, so a down
    // alacarte or a rate limit isn't hammered.
    if (err.status === 504) results.set(key, { state: "retry" });
    else if ([0, 429].includes(err.status)) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      results.set(key, { state: "retry" });
    } else results.set(key, { state: "failed", error: err.message });
  }
}

function request(settings, downloadId, trackId) {
  const key = `${downloadId}:${trackId}`;
  if (open.has(key) || waiting.some((job) => job.key === key)) return;
  waiting.push({ key, settings, trackId });
  pump();
}

// ---- the download source -------------------------------------------------

export default {
  async test({ settings }) {
    const out = await call(settings, `/search?q=${encodeURIComponent("radiohead")}&songs=1&albums=0&artists=0`);
    if (!Array.isArray(out?.songs)) throw new Error("alacarte answered, but not like its integration API");
    return { message: "Connected to alacarte" };
  },

  downloadSource: {
    async searchAlbum({ settings, album }) {
      if (!album.title) return [];
      const term = [album.artist, plainTitle(album.title)].filter(Boolean).join(" ");
      const out = await call(settings, `/search?q=${encodeURIComponent(term)}&songs=0&albums=15&artists=0`);
      const artist = fold(album.artist);
      const wanted = album.tracks?.length || null;
      return (out?.albums ?? [])
        .filter((found) => {
          if (!artist) return true;
          const theirs = fold(found.artist);
          return theirs.includes(artist) || artist.includes(theirs);
        })
        .map((found, order) => ({ found, order }))
        .sort(
          (a, b) =>
            // Closest track count first, then Apple's own order.
            (wanted ? Math.abs((a.found.trackCount ?? 0) - wanted) - Math.abs((b.found.trackCount ?? 0) - wanted) : 0) ||
            a.order - b.order,
        )
        .slice(0, 50)
        .map(({ found }) => ({
          id: String(found.id),
          title: plainTitle(found.title),
          artist: found.artist,
          year: found.year ?? null,
          trackCount: found.trackCount ?? null,
          format: "flac",
        }));
    },

    async downloadAlbum({ settings, dataFolder, result }) {
      const found = await call(settings, `/albums/${encodeURIComponent(result.id)}`);
      const tracks = (found?.tracks ?? []).map((track) => String(track.id));
      if (!tracks.length) throw new Error("alacarte has no downloadable tracks for this album");
      const id = `${result.id}-${Date.now().toString(36)}`;
      await saveState(dataFolder, {
        id,
        albumId: String(result.id),
        title: found.title,
        tracks: Object.fromEntries(tracks.map((track) => [track, { state: "wanted" }])),
      });
      limit = parallelLimit(settings);
      for (const track of tracks) request(settings, id, track);
      return { pending: id };
    },

    async status({ settings, dataFolder, id }) {
      const state = await loadState(dataFolder, id);
      if (!state) throw new Error("The plugin lost track of this download");
      limit = parallelLimit(settings);

      let changed = false;
      for (const [track, entry] of Object.entries(state.tracks)) {
        const key = `${id}:${track}`;
        const outcome = results.get(key);
        if (outcome) {
          results.delete(key);
          if (outcome.state !== "retry") {
            state.tracks[track] = outcome;
            changed = true;
            continue;
          }
        }
        // Still wanted: make sure a request is open or waiting. This also
        // restarts requests after the plugin's process was restarted.
        if (entry.state === "wanted") request(settings, id, track);
      }
      if (changed) await saveState(dataFolder, state);

      const entries = Object.values(state.tracks);
      if (entries.some((entry) => entry.state === "wanted")) return { done: false };

      const filed = entries.filter((entry) => entry.state === "done").length;
      await rm(stateFile(dataFolder, id), { force: true });
      if (!filed) {
        const reason = entries.find((entry) => entry.error)?.error;
        throw new Error(`alacarte couldn't download ${state.title}${reason ? `: ${reason}` : ""}`);
      }
      if (filed < entries.length)
        console.log(`${state.title}: ${entries.length - filed} of ${entries.length} tracks failed`);
      return { done: true, filed };
    },

    // alacarte's integration API can't cancel a queued job, so tracks already
    // asked for still download; the plugin only stops asking for the rest.
    async discard({ dataFolder, id }) {
      discarded.add(id);
      for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].key.startsWith(`${id}:`)) waiting.splice(i, 1);
      await rm(stateFile(dataFolder, id), { force: true });
    },
  },
};
