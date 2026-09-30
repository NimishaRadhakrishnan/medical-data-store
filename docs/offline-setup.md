# Running the shop with no internet

The billing app lives in `apps/shop`. It runs entirely on the shop's own
computer: its own database file, its own little server, its own screens. Pull
the network cable out and everything below still works — billing, stock,
printing, reports and Excel exports.

---

## What it is made of

| Piece | What it is | Why |
|---|---|---|
| Database | SQLite, one file at `apps/shop/data/shop.db` | No database server to install or keep running. One file to back up. |
| Server | Node's own HTTP server, on `127.0.0.1:8123` | Listens on this computer only, so nothing is exposed to the network. |
| Screens | Plain HTML, CSS and JavaScript from that server | No build step, nothing downloaded from the internet — not even fonts. |
| Excel | Written by the app itself | No library to install. |
| QR labels | Drawn by the app itself | Same reason. The codes are checked against a real scanner's decoder before release. |

**Nothing is installed except Node.** The app has no dependencies at all, which
is deliberate: `npm install` needs the internet, and a shop counter should not.

---

## Putting it on the shop's computer

Do this once, at the shop, with the internet on for step 1 only.

**1. Install Node.** Download the Windows LTS installer from nodejs.org on any
computer, carry it on a pen drive, and run it. Version 22 or newer — the app
uses Node's built-in database, which older versions do not have. Accept every
default.

**2. Copy the folder.** Put `apps/shop` somewhere simple, for example
`C:\SriNachiya`. Keep the whole folder together.

**3. Start it.** Double-click `start.bat`. A black window opens and stays open,
and the browser opens `http://localhost:8123`. The first screen asks for the
shop's details — name, address, GSTIN and both drug licence numbers, from the
certificates. These print on every bill.

**4. Make it start with the computer.** Press `Win + R`, type
`shell:startup`, press Enter, and put a shortcut to `start.bat` in the folder
that opens. Now the app is ready whenever the PC is switched on.

**5. Set the printer.** Make the thermal printer the Windows default. Print a
test bill and check the batch, expiry and GST lines are in the right place.

**5a. Get something that can see (optional).** The app prints its own QR label
for every batch, so a **plain USB webcam at ₹500–800** is enough — no barcode
scanner needed. Point it down at the counter. A laptop's built-in camera works
too. See "Labels and scanning" below.

**6. Enter the opening stock.** For the first day, use **Medicines → Add many
at once** rather than typing each medicine into a dialog — a shop with four
hundred medicines would take days that way. Keep the list in Excel, copy the
rows and paste them in, or save it as a `.csv` and choose the file.
**Download a blank sheet** from that screen to see the columns.

Only the medicine name is needed; everything else can be filled in as each one
is first bought. If the sheet also carries a batch, expiry, quantity and MRP,
the opening stock goes onto the shelf in the same step — choose the distributor
first.

Nothing is written until you press **Check the list**, which shows how many
will be added, how many are already there, and every row that cannot be used
with its line number and the reason. Fix those few in the spreadsheet and paste
again; the good rows are saved regardless, so a long list never has to be
imported twice.

**Then, as deliveries arrive:** Add the distributors first, then the medicines
as deliveries arrive. Start with the fast movers; everything else can be added
the first time it is bought.

**7. Test it with the internet off.** Unplug the cable, or turn off Wi-Fi. Make
a bill, print it, add a delivery, open the reports, download an Excel file.
All of it must work. Then restart the PC and check the bills are still there.

---

## Entering a distributor's invoice

The invoice that arrives with a delivery — Palepu Pharma's, for example — has
one row per medicine. The **Add stock** screen is laid out to be read straight
across from it:

| On the invoice | On the screen |
|---|---|
| PRODUCT PACK | Medicine |
| BATCH | Batch number |
| EXP Date (05/28) | Expiry month / year |
| QTY | Strips received |
| Sch%/free | Free strips |
| New MRP | MRP per strip |
| Trade Price | Trade price per strip |
| **Dis %** | **Discount %**, typed once at the top |

**The discount matters more than it looks.** The Trade Price is the price
*before* the distributor's discount. On the invoice above, 4% comes off every
line — so a medicine printed at ₹129.46 actually costs ₹124.28. Enter 4 in the
**Discount %** box once, and every line below is worked out from the real cost.
Leave it at 0 and the shop appears to be making about three points less profit
than it really is, on everything.

The screen shows both figures — `₹124.28` with `₹129.46 less 4%` underneath —
so a mistyped discount is obvious straight away.

**Free goods** ("Sch%/free") are entered separately. Ten bought and one free
means the eleven packs each cost a little less, and the app works that out.

**What the invoice's QR code is.** It says *Scan to Pay* — it is a payment code
for the outstanding amount, not a list of the medicines. Scanning it cannot
load the delivery into the app, and no printed invoice QR can: even a proper
GST e-invoice QR carries only the invoice's totals and its signature, never the
batch numbers and expiry dates. Those have to be typed, or come from the
distributor as a file. It is worth asking the representative whether they can
send the invoice as a CSV or Excel file; if they can, importing it is a small
addition.

---

## Labels and scanning

Most packs that arrive carry either no printed code at all, or a plain barcode
that names the medicine but not the batch. Neither is much use at a counter.
So the app **prints its own label instead**, one for each batch:

```
Sri Nachiya Medicals            ▄▄▄▄▄ ▄ ▄▄▄▄▄
Dolo 650  OTC                   █ ███ █▀▄ █ █
Batch B4471                     █▄▄▄█ ▀▄█ █▄█
Expiry 10/2027                    SNM-B1-7
₹33.10 per strip
```

That little square holds one thing: the batch's own short code. Nothing about
the shop, no price, no internet address — so a label is useless to anyone else,
and a price change never makes a printed label wrong.

**Printing them.** After saving a delivery the app offers **Print labels** —
that is the moment, with the boxes still on the counter. It prints an A4 sheet,
which works on ₹1-a-sheet sticker paper or on ordinary paper cut with scissors.
Ask for more than one per box if you want a label on each strip. To print one
again later: **Medicines → the medicine → Label.**

**Reading them.** Click **Scan with the camera** on the New bill screen and hold
the box up. The medicine, the batch, the expiry and the price all land on the
bill together, and it keeps reading one strip after another without clicking
again. This works in **any browser** — Chrome, Edge, Safari or Firefox. Chrome
and Edge can read codes themselves; everywhere else the app uses the reader
kept beside it in `public/qr-reader.js`, so nothing is fetched and nothing is
installed.

**Why the batch matters.** Normally the app sells the oldest stock first. When
a label is scanned it sells *that* strip instead — so the expiry printed on the
customer's bill is the expiry of the strip actually handed over. Expired stock
is still refused, scanned or not.

**A USB barcode scanner** works too if the shop already has one, or wants to
read the manufacturers' own codes: a **2D imager**, ₹3,000–6,000, since the new
Schedule H2 codes are square, not striped. Windows treats it as a keyboard —
click the box on screen first, then pull the trigger. The first time a
manufacturer's code is scanned the app asks which medicine it belongs to; it is
remembered from then on.

**Neither?** Nothing is blocked. Type the first few letters of the name. The
whole app works exactly the same, just slower.

| It did nothing | Why |
|---|---|
| Camera button is missing | The browser is Safari or Firefox. Use Chrome or Edge. |
| Camera asks for permission | Allow it once; the answer is remembered. |
| "That label is not in this computer" | The sticker is from an older database, or torn. Print a fresh one. |
| A USB scanner types but nothing happens | The cursor was not in a box, or the scanner does not send Enter — its manual has a setup barcode for that. |

The codes are checked, not guessed: every one carries a check character, so a
damaged or half-read label is refused rather than being treated as some other
batch. A label still reads with about a quarter of it rubbed away.

---

## The PIN

A four-digit PIN stands in front of the few things that can do damage. It is
optional — leave it empty at setup and the app behaves as if it were never
there.

**It never asks during billing.** Searching, adding to a bill, saving, printing
and reprinting a label all work whether the shop is locked or not. The till must
never stop.

**It asks before:** changing a price, correcting stock, cancelling a bill,
deleting a medicine, distributor or scanned code, changing the shop's details,
restoring a backup — and before showing what stock cost and what you make on it.

Once given, it stays unlocked for 15 minutes of work. **Lock now** in the top bar
locks it at once, and so does closing the black window or switching the PC off.

**If the PIN is forgotten:** make an empty file called `RESET-PIN.txt` in the
same folder as `shop.db` (right-click → New → Text Document, name it exactly
that), then start the app. The PIN is cleared and the file removed. Set a new
one in Settings.

**Be clear about what it is.** It stops someone idly pressing things while you
are at the back of the shop. It is not protection against a person who has the
computer — `shop.db` sits beside the app and can simply be copied. What actually
protects the shop is the Windows password, where the machine sits, and the
backup kept off the premises.

---

## Every day

Nothing. Switch the computer on; the app is already running. Leave the black
window open while the shop is working — closing it stops billing, and
double-clicking `start.bat` starts it again with nothing lost.

---

## Backups

A copy of the whole database is saved in `apps/shop/data/backups`:

- when the app starts
- every evening after 9 PM
- whenever you press **Back up now** in Settings
- when the app is closed properly

The last 30 evening copies are kept. **Copy that folder to a pen drive once a
week** and keep the drive away from the shop — a fire or a theft takes the
computer and everything on it.

To go back to an earlier copy: **Settings → Restore this**, then type RESTORE.
The current database is kept beside it with a `.replaced-…` name, so even a
restore can be undone.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| "App not running — restart it" | Double-click `start.bat`. Nothing is lost. |
| The black window was closed | Same: `start.bat`. |
| The browser shows nothing at `localhost:8123` | The app is not running. Start it. |
| The printer does nothing | The bill is already saved. Check paper and power, then print it again from **Reports → Daily sales**. |
| Power cut in the middle of a bill | The bill was either saved completely or not at all. Check **Last bills** and re-enter if it is missing. |
| "the stock figures do not match" | Open **Settings → Check the figures**. If it is not happy, stop and call for help before billing more. |
| The computer has died | Install Node on any computer, copy the folder from the pen drive, run `start.bat`. |

---

## Moving to a new computer

1. Install Node on the new PC.
2. Copy the whole `shop` folder across, including `data`.
3. Run `start.bat`.

The bills, stock, prices and history come with the file.

---

## What is deliberately not here

- **No cloud account, no subscription, no domain.** Nothing to renew, nothing
  to pay monthly, nothing that stops working when a card expires.
- **No login.** The shop's own computer is the key. If the owner ever wants the
  figures on his phone, that needs the cloud half of this project
  (`supabase/`), which is optional and switched off.
- **No automatic updates.** A new version is a folder copy, done deliberately,
  never in the middle of a working day.

---

## For whoever maintains it

```bash
cd apps/shop
npm start                 # or: node server.js
npm run check             # does the stock still match its history?
npm run backup            # take a backup from the command line
```

From the project root:

```bash
npm run test:app          # 158 tests against a real database and a real server
npm run test:qr           # hands the printed codes to a real scanner's decoder
npm run test:camera       # holds a label up to a real browser camera
```

`test:qr` needs `pip install zxing-cpp pillow numpy`, and `test:camera` needs
`npm install -D playwright`. Both are checks for whoever changes the QR code or
the camera; neither is needed to run the shop, and neither goes anywhere near
the shop computer.

`test:qr` is the one check that needs something extra
(`pip install zxing-cpp pillow numpy`) and is a developer check only — nothing
of the sort goes near the shop computer. It matters because a QR code that
looks perfect but does not decode would only be discovered weeks later, with
the stickers already on the boxes.

Environment variables, if a different layout is ever needed:

| Variable | Default | Meaning |
|---|---|---|
| `SNM_DB` | `apps/shop/data/shop.db` | Where the database file lives |
| `SNM_BACKUPS` | `data/backups` beside it | Where backups are written |
| `SNM_PORT` | `8123` | The port on this computer |

The database rules — append-only stock history, no selling expired stock, no
editing a saved bill, prescription details for Schedule H1 — are enforced by
the database itself in `apps/shop/schema.sql`, not only by the screens. Any
future screen, script or import obeys them too.
