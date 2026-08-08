# StreamElements custom widget

Tallies YouTube Super Chats into a running USD total, reading them from the messages
RestreamBot already relays into your Twitch chat:

```
RestreamBot: [YouTube: @user] Super Chat - 7.77 USD
```

**Nothing to host, nothing to install, no API keys.** It runs inside your StreamElements
overlay and only reads chat messages that StreamElements already hands to widgets.

## Requirements

- Restream's **relay mode** enabled, so YouTube chat (including Super Chats) is posted into
  your Twitch chat by RestreamBot.
- A StreamElements overlay that you load in OBS.

## Setup

1. Open your overlay in the **StreamElements overlay editor**.
2. **Add widget → Static / Custom → Custom Widget**.
3. Click the widget, then open **Settings → Open Editor**. You get four tabs:

   | Tab | Paste in |
   | --- | --- |
   | HTML | `widget.html` |
   | CSS | `widget.css` |
   | JS | `widget.js` |
   | Fields | `fields.json` |
   | Data | *nothing*, StreamElements fills this in itself with your saved settings |

4. **Save**. The widget's settings panel now shows the options below.
5. Size and position the widget box in the editor, it renders one line, so something like
   520 × 90 works well.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Log parsing to the console | Off | Turn on while testing, see Troubleshooting. |
| Label | `YouTube Tips:` | The text before the amount. |
| Hide until the first Super Chat | No | Keeps the overlay clean at $0.00. |
| Start a new total after … hours idle | 5 | How a new stream gets a fresh total. See below. |
| Chat command to reset now | `!tipsreset` | You and your moderators only. |
| Command to add to the total | `!tipsadd` | Manual fallback, see below. |
| Command to subtract from the total | `!tipsremove` | Manual fallback, see below. |
| Always allow these usernames | *(empty)* | Optional escape hatch — mods and broadcaster are detected automatically. |
| Storage key | `ytSuperChatTotal` | Only change it if you run two of these. |
| Font / size / weight | Nunito, 30px, regular | Any Google Font; condensed ones match the reference look. |
| Text, outline, flash colours | red on near-black | Outline keeps it readable over any footage. |
| Outline width | 2px | 0 disables the outline. |
| Alignment | Left | Keeps the label anchored as digits change width. |

## How the total resets

The widget reloads whenever your overlay loads, which is when you start streaming. On load it
looks at how long ago the last Super Chat was:

- **Longer than "Start a new total after … hours idle"** → new stream, total starts at $0.00.
- **Shorter** → you restarted OBS mid-stream, so the previous total is picked back up.

You can always reset immediately with `!tipsreset` in chat (broadcaster and moderators only).
Set the idle hours to `0` to disable automatic resets entirely and rely on the command.

## Correcting the total by hand

The relay can miss a Super Chat, or post one you don't want counted. You and your moderators
can fix the total from chat:

```
!tipsadd 7.77          adds $7.77
!tipsadd 50 SEK        converts, then adds (any currency code works)
!tipsremove 5          subtracts $5.00
!tipsremove 12,50 EUR  decimal commas are fine too
```

With no currency given the amount is treated as USD. Corrections are stored exactly like
relayed Super Chats, so they survive an overlay reload and are included in the total the same
way. Removing more than the current total floors it at $0.00 rather than going negative.

### Who can use the commands

All three commands (`!tipsreset`, `!tipsadd`, `!tipsremove`) are restricted to **you and your
moderators**. This is automatic — the widget reads Twitch's own badges, so there is no list to
maintain. Subscribers, VIPs and regular viewers are refused and their attempts are logged.

The *"Always allow these usernames"* setting is an **optional escape hatch and is empty by
default**. StreamElements does not document the exact shape of the badge data it sends widgets,
so if it ever arrives in a form the widget doesn't recognise and even you can't run the
commands, put your username there to get back in. Under normal circumstances you never need it.

All three command names are renameable in the settings.

## Troubleshooting

**The total never moves.** Turn on *Log parsing to the browser console*, then open the overlay
in a browser (the overlay URL from StreamElements) and watch the console while a Super Chat
comes in. You will see either `relay message: …` (the bot was recognised) or nothing at all
(the sender name did not match, check the *Relay bot username* setting).

**Real Super Chats aren't being counted.** The parser deliberately accepts only the exact
structure `[YouTube: @handle] Super Chat - 7.77 USD` (see *Can viewers fake a Super Chat?*), so
if Restream changes the wording even slightly, nothing will count. Turn on console logging, copy
the line the bot actually posted, and the pattern can be updated to match.

**The number is doubled.** Two copies of the widget are counting, most likely the overlay is
open in the StreamElements editor preview *and* in OBS. They de-duplicate by chat message id
and share one stored total, so this should self-correct; if it does not, give one of them a
different *Storage key* or close the editor.

**Currency conversion looks off.** Rates come from a free daily feed
([@fawazahmed0/currency-api](https://github.com/fawazahmed0/exchange-api)). If it is
unreachable the widget falls back to an approximate built-in table and logs a warning, a few
cents of drift is expected either way.

## Development

The widget logic can be exercised locally without StreamElements:

```bash
node widget/test/harness.mjs --playwright /path/to/playwright
```

It stubs `SE_API.store` and the `onWidgetLoad` / `onEventReceived` events, substitutes
`{{fieldName}}` values into the HTML and CSS the way StreamElements does, feeds real
RestreamBot-formatted lines through `widget.js`, asserts the rendered totals, and writes a
screenshot to `widget/test/widget-render.png`.

Styling lives in the CSS tab via `{{...}}` interpolation rather than being applied from JS, so
the overlay looks right even if the script fails. `widget.js` only reads the *behavioural*
fields (bot name, reset command, idle hours) from `fieldData`.
