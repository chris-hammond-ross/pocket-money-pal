# Sound credits

The sounds in the first table are by **Kenney Vleugels ([kenney.nl](https://www.kenney.nl))** and released under **[Creative Commons Zero (CC0 1.0)](https://creativecommons.org/publicdomain/zero/1.0/)**. They may be used, changed and redistributed, commercially or not, without asking. Credit isn't required, but it's given here with thanks.

Each sound ships as the original `.ogg` and a 64 kbps mono `.mp3` copy (converted with ffmpeg) for browsers that can't play Ogg.

| File       | Used for                            | Pack                                                          | Original file               |
| ---------- | ----------------------------------- | ------------------------------------------------------------- | --------------------------- |
| `pop`      | a claim outside bonus time          | [Interface Sounds](https://kenney.nl/assets/interface-sounds) | `drop_002.ogg`              |
| `coin`     | an approval, bonus points           | [Digital Audio](https://kenney.nl/assets/digital-audio)       | `highUp.ogg`                |
| `sad`      | a send-back, a penalty              | [Digital Audio](https://kenney.nl/assets/digital-audio)       | `lowDown.ogg`               |
| `clink`    | each coin poured into a jar         | [Casino Audio](https://kenney.nl/assets/casino-audio)         | `chip-lay-1.ogg`            |
| `smash`    | smashing a full jar, deleting a jar | [Impact Sounds](https://kenney.nl/assets/impact-sounds)       | `impactGlass_heavy_001.ogg` |
| `whoosh`   | an envelope arriving                | [Casino Audio](https://kenney.nl/assets/casino-audio)         | `card-slide-1.ogg`          |
| `chime`    | an envelope arriving or opening     | [Interface Sounds](https://kenney.nl/assets/interface-sounds) | `confirmation_002.ogg`      |
| `chaching` | points turning into money at payday | [RPG Audio](https://kenney.nl/assets/rpg-audio)               | `handleCoins.ogg`           |

`drumroll` (the start of the payday show) isn't from a pack: it was generated for this project with ffmpeg from filtered noise (`anoisesrc`, pulsed 18 times a second and getting louder), and is released under CC0 like the rest.

These were also generated for this project with ffmpeg (`aevalsrc` expressions of plain tones and noise, ADR 0012) and are released under CC0:

| File     | Used for                             | How                                                         |
| -------- | ------------------------------------ | ----------------------------------------------------------- |
| `bloop`  | a bonus that ran out unclaimed       | two soft sine notes falling, 660 Hz then 440 Hz             |
| `grow`   | the morning report: the streak grows | a three-note rise (C5, E5, G5), triangle waves              |
| `fizzle` | the morning report: the streak ended | a sine sliding down from 500 Hz, with a fading crackle      |
| `flip`   | the level-up number turning over     | a 1.4 kHz click with a little noise                         |
| `alarm`  | a surprise quest pops up (spec 006)  | B5 and F#5 beeping 10 times a second, softened square waves |

These copy the kiosk prototypes' WebAudio sounds (`prototypes/_shared/proto-kit.js`), rendered to WAV with a small Node script (band-limited waves, the same exponential envelopes) and encoded with ffmpeg. They're released under CC0:

| File      | Used for                          | How                                                                 |
| --------- | --------------------------------- | ------------------------------------------------------------------- |
| `fanfare` | a claim in bonus time, a level-up | four rising triangle notes (C5, E5, G5, C6) 120 ms apart, last held |
| `jingle`  | a jar passing a milestone         | the prototype's "ding": sine bells at A5, then E6 80 ms later       |
| `tick`    | setup ticks, the bonus tick-tock  | a 30 ms 1.8 kHz square-wave click                                   |
| `tap`     | tapping a quest, buttons          | a 50 ms 900 Hz square-wave click                                    |

The tock of the tick-tock is `tick` played at two-thirds speed (1.2 kHz, the prototype's tock).

Adding a sound: keep it CC0 (or another licence that allows redistribution), keep it short and small, add both formats, and add a row here.
