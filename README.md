# aurral-alacarte

An [Aurral](https://github.com/lklynet/aurral) 3 plugin that downloads albums from Apple Music through [alacarte](https://github.com/norifm/alacarte).

When Aurral wants an album, the plugin searches alacarte for it, then asks alacarte to download each of its tracks through alacarte's integration API (the one octo-fiesta uses). alacarte files the tracks in its own music folder, and Aurral plays them from there as a read-only folder. Aurral never moves or changes those files, so nothing is stored twice, and any media server reading that folder sees them as before.

Not affiliated with Aurral or alacarte. Use alacarte only for music your Apple Music subscription covers, as its own README says.

## Setup

1. In alacarte, turn on **Settings > Integrations** and copy the integration token.
2. Mount alacarte's music folder in the Aurral container, read-only (for example at `/music`), and add that path under Aurral's **Settings > Library** as a read-only folder.
3. Install the plugin: in Aurral's **Settings > Plugins**, paste `https://github.com/adam-fox/aurral-alacarte` under **Install from a link**, or copy the `alacarte` folder into Aurral's `/config/plugins`.
4. Open **Settings > Plugins > alacarte**, enter alacarte's URL (for example `http://alacarte-web:7373` when both containers share a Docker network) and the token, select **Test**, and turn it on.

## How it behaves

- **Albums only.** A single track comes from its album, because Aurral can only leave files in another app's folder for album downloads. A request for one song downloads the whole album.
- **One song at a time.** alacarte downloads one job at a time. The plugin keeps a few track requests open (3 by default, set on the plugin's page) and asks again when alacarte answers that a song is still queued.
- **Partial albums count.** If some tracks fail, the album finishes with the ones that downloaded. If none do, Aurral moves on to its next source.
- **Cancelling** in Aurral stops the plugin asking for more tracks, but tracks already queued in alacarte still download; its integration API can't cancel a job.
- **Apple rate limits.** alacarte's author was blocked for about a day after roughly 1,500 songs. Flows and daily mixes request music on a schedule, so keep them small or leave this source out of them.
- **Matching.** alacarte writes Apple's tags, not MusicBrainz IDs, so Aurral finds each album by artist and album name. On first setup, Aurral looks up every untagged album in the read-only folder, which can get it rate-limited by its catalog service for a few hours on a large library. Explicit and clean versions are separate Apple albums; alacarte's own Settings pick which one it shows.

Progress for each album is kept in the plugin's data folder, so a restarted plugin process picks up where it left off.

## Files

- [`alacarte/manifest.json`](alacarte/manifest.json): settings and capabilities.
- [`alacarte/index.js`](alacarte/index.js): the plugin, with no dependencies.

## License

MIT
