# A one-person shop

Sri Nachiya Medicals has one user: the owner. He bills customers, takes
deliveries, sets prices and checks the day's takings himself. He knows pharmacy
well — batch, MRP, expiry, H1, GST — and has never used billing software.

That changes the plan in two ways:

1. **Everything built for staff goes.** No roles, no PINs, no permission
   tables, no second counter.
2. **Every screen must work for someone with no computer training.** No
   technical words, no codes to memorise, nothing that needs looking after.

This document says what the owner does, what he never has to do, what was
removed, and what you set up once before handing it over.

---

## What the owner does

Four screens, each a button across the top. Nothing is hidden in menus.

| Screen | What he does there |
|---|---|
| **Bill** | Types a few letters of a medicine, picks it, chooses how many (tablets, strips or boxes), picks Cash / UPI / Card / Credit, presses **Save and print bill**. |
| **Add stock** | When a delivery comes: scans the box, or types the medicine, batch, expiry, quantity and price from the invoice. Then **Save delivery**. |
| **Medicines & prices** | Fixes a price entered wrongly, or changes a medicine's details. |
| **Sales** | **Day**: sales and what he made, compared with the same day last week; what's expiring, what can go back to the distributor, what customers asked for, and the cash count before closing. **Month**: the month so far against the same days last month, a bar for every day, best sellers, weekday pattern, and the GST figures for his CA. Previous days and months are one tap back. |

On his phone: the same **Sales** screen, and a notification at 9 PM with the
day's summary.

### How the screens were made easy

- **Buttons, not codes.** Quantity is a number plus a **Tablets / Strips /
  Boxes** choice, not `2s` or `1b`. Payment is four buttons. Keyboard
  shortcuts still work, but nothing depends on knowing them.
- **Shop words, not computer words.**

  | Instead of | The screen says |
  |---|---|
  | Synced / offline / queued | "Online · everything saved" / "No internet · 3 bills saved on this computer" |
  | Stock movement, ledger | "stock" |
  | FEFO | Nothing: it simply sells the earliest expiry first |
  | PTR, cost price | "Cost, from the invoice, before GST" |
  | Margin | "You make ₹4.92 per strip (18.8%)" |
  | Schedule H1 validation | "Prescription record needed (Schedule H1)" |
  | SKU | "medicine" |

- **Every message says what to do next.** Not "Invalid input", but "Cost
  ₹248.00 is more than the MRP ₹148.00. Check the invoice — you would lose money
  on every sale."
- **The app fills in what it can.** Scanning the box fills the medicine, batch
  and expiry. Choosing a medicine fills last time's MRP and cost to check against
  the invoice. Free strips work out the real cost per strip by themselves.
- **One reason, one tap.** Changing a price asks why from a short list: a
  mistake when adding stock, the company changed the MRP, or the distributor
  changed the price. The history then explains every change without any typing.
- **Warnings before mistakes, not after.** An expired delivery is refused at
  the door. A short expiry, a changed MRP or a big price jump each get a
  plain-language warning.
- **Big targets.** 16px text, buttons at least 40px tall.

### Language

Ask him whether he wants the screens in Tamil. If yes, translate the buttons
and messages, but keep the words shops actually use in English — MRP, batch,
strip, GST. Have the owner or another native speaker check every line. A wrong
word on a billing screen is worse than English.

---

## What the owner never has to do

If any of these ever lands on him, the setup has failed.

- Open Supabase, Cloudflare, GitHub or any other dashboard
- Type a command, edit a file, or install an update — the app updates itself
- Remember more than one password — he stays signed in on the PC and the phone
- Take backups — they run every night by themselves
- Renew the domain — registered for five years with auto-renew on
- Understand sync — when the internet comes back, saved bills go online on
  their own

---

## What was removed for a one-person shop

| Removed | Why | What happens to the code |
|---|---|---|
| Owner / pharmacist / counter-staff roles | One user | The database keeps the owner role, so everything works unchanged. If he ever hires help, it is ready. |
| Hiding cost price from staff | No staff | The owner sees cost and profit everywhere. The billing screen still never shows cost, because a customer can see it. |
| Staff PINs, staff discount tracking | No staff | Not built. |
| Second counter and stock-difference handling | One computer | Migration 0005 stays; it does nothing unless a second device is ever added. |
| Telegram message | One more app to install and understand | Replaced by a notification from the phone app. |
| Asking Claude about the shop (MCP server) | Needs a laptop, a Claude account and setup | Optional. Offer it only if he already uses Claude. |
| Quantity codes and required shortcuts | Must be learnt | Replaced by buttons; the shortcuts remain as a bonus. |

**Kept, because the law or the money needs it:** the H1 prescription record,
GST on every bill, expiry blocking, the return-to-distributor list, the daily
summary, and the monthly GST pack for the CA.

---

## Still to build before he can use it

The prototype shows every screen working. These pieces are needed for the real
thing:

1. The real database behind the screens, and the offline storage on the PC
2. **Add a new medicine** from the Add stock screen, for anything not yet in
   the list
3. **Cancel a bill** and **take back a return**
4. **Print a bill again**
5. The phone app and the 9 PM notification
6. **First-time setup**: shop name, address, GSTIN and licence numbers, entered
   once and printed on every bill
7. Automatic backups, and a line on the Sales screen saying when the last one
   ran

---

## What you set up once, before handing over

| | Step | Done when |
|---|---|---|
| 1 | Supabase **Pro**, Mumbai region, paid with the owner's card, spend cap on | The project shows Pro and the Mumbai region |
| 2 | Domain in the owner's name, **5 years, auto-renew on** | The registrar shows the expiry date 5 years out |
| 3 | Deploy to Cloudflare Pages on that domain | The site loads on his phone over mobile data |
| 4 | Install the app on the shop PC; open it at startup; sign in once | He switches the PC on and the Bill screen appears |
| 5 | Printer and scanner test | 10 test bills print cleanly; a scanned box fills the form |
| 6 | Phone: install the app, allow notifications | A test notification arrives |
| 7 | First-time setup: GSTIN and drug licence numbers from his certificates (the shop's address, GSTIN and licence are already filled in from the distributor's invoice) | The printed bill shows his real GSTIN and licence numbers, not blanks |
| 8 | Opening stock, top 300 medicines first | He can bill his ten best-sellers |
| 9 | Nightly backup on, and **one test restore** | You restored a backup and it matched |
| 10 | Print the "If something goes wrong" card below and tape it beside the PC | It's on the wall |
| 11 | A 30-minute walkthrough: a bill, a delivery, a price change, the Sales screen | He does all four without help |
| 12 | Two weeks alongside the paper bill book, checking the day's total every evening | 14 days match to the rupee |

Afterwards, spend 10 minutes a month checking that backups ran and that no
errors are building up. He should never need to call you for routine things.

**What it costs him:** about ₹2,200 a month for the database, about ₹900 a year
for the domain, plus thermal paper.

---

## If something goes wrong

Print this and keep it beside the computer.

> **The top of the screen says "No internet"**
> Keep billing as normal. Bills are saved on this computer and go online by
> themselves when the internet is back. If it has been off for more than a day,
> call ______.
>
> **The power goes off**
> The UPS gives you about 15 minutes. Finish and save the bill you are on, then
> switch off. Nothing that was saved is lost.
>
> **The bill doesn't print**
> The bill is already saved. Check the printer has paper and its light is on,
> then print it again.
>
> **You typed a wrong price when adding stock**
> Go to **Medicines & prices**, pick the medicine, press **Change price** on
> that batch.
>
> **A medicine isn't in the list**
> Add it from **Add stock** when it arrives.
>
> **The computer stops working**
> Use any computer with Chrome. Open **srinachiyamedicals.in** and sign in.
> Everything is there, except bills made while the internet was off that
> hadn't gone online yet — so if the internet was off when the computer
> failed, call ______.
>
> **Anything else**
> Call ______ on ______.
