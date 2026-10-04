# Built in audio provenance

The Lantern Table starter catalog contains **25 one shot effects, 3 ambience loops, and 3 music tracks**. The pack is approximately 11.4 MB. Every playable asset is CC0 1.0; the catalog records the individual file hash, exact source asset, source page, creator, license, category, channel, and tags in [`assets/audio/catalog.json`](assets/audio/catalog.json).

## Sources

- **Kenney RPG Audio** — Kenney Vleugels, CC0 1.0. The upstream pack's license file is preserved at [`assets/audio/licenses/Kenney-RPG-Audio-License.txt`](assets/audio/licenses/Kenney-RPG-Audio-License.txt). Source: [kenney.nl/assets/rpg-audio](https://kenney.nl/assets/rpg-audio). Used for doors, creak, latch/metal, containers, blade handling, impacts, coins, books/pages, gear, and footsteps.
- **Wooden knocks** — original short synthesized knock effects created for Lantern Table and released under CC0 1.0. The three low wooden impacts are generated locally and bundled as Ogg Vorbis.
- **Opening lock and door** — RPG, CC0 1.0. [OpenGameArt asset page](https://opengameart.org/content/opening-lock-and-door), `door_open.mp3` (upstream storage filename: `door_open_1.mp3`).
- **Forest Ambience** — Slobad, CC0 1.0. [OpenGameArt asset page](https://opengameart.org/content/forest-ambience), `Forest_Ambience.mp3`.
- **Loopable Dungeon Ambience** — IgnasD, CC0 1.0. [OpenGameArt asset page](https://opengameart.org/content/loopable-dungeon-ambience), `dungeon_ambient_1_0.ogg`.
- **Dark Cavern Ambient** — Paul Wortmann, CC0 1.0. [OpenGameArt asset page](https://opengameart.org/content/dark-cavern-ambient), `dark_cavern_ambient_002.ogg`.
- **Battle Theme** — Wolfgang_, CC0 1.0. [OpenGameArt asset page](https://opengameart.org/content/battle-theme-0), `Battle.mp3`.
- **Town Theme RPG** — cynicmusic, CC0 1.0. [OpenGameArt asset page](https://opengameart.org/content/town-theme-rpg), `TownTheme.mp3`.
- **Medieval: The Old Tower Inn** — AntumDeluge, CC0 1.0. [OpenGameArt asset page](https://opengameart.org/content/medieval-the-old-tower-inn), `Loop_The_Old_Tower_Inn.wav`, converted to Ogg Vorbis quality 4.

OpenGameArt provenance was checked against each individual asset page's license field. Inclusion in a collection alone was not treated as license evidence. All long tracks are loaded on demand; a small selection of short one shots is preloaded after startup.
