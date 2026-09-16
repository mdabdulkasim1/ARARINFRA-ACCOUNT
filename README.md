# ARAR INFRA &middot; Accounts

An internal cash-out control system for the ARAR INFRA group.

It answers the questions the owner actually asks:

- **How much do we owe each supplier?**
- **How much have we already covered with post dated cheques?**
- **What is overdue, and by how many days?** (shown in red, so it cannot be missed)
- **Who is drawing petty cash, and what is waiting for my approval?**

No invoice scans or attachments are stored. Only the supplier's own invoice
reference number, the invoice date and the date it was submitted to us.

---

## The idea behind it

**Payment terms run from the submitted date, not the invoice date.**
A supplier may date a bill the 1st and hand it over on the 20th. On 90 day terms
the money is due 90 days after the 20th. Every due date, overdue flag and ageing
bucket in the system is counted that way.

**A post dated cheque is a commitment until it clears; it is money only once it does.**
That is why three separate figures are tracked against every invoice:

| Figure | What it means |
| --- | --- |
| **Payable** | What the supplier is still owed |
| **PDC issued** | Cheques handed over that have not cleared yet |
| **Still to arrange** | Payable less those cheques - the cash actually still to be found |

When a cheque clears, it moves from *PDC issued* into *paid*. When one bounces,
the amount goes straight back onto the payable.

**An advance is a payment without an invoice yet.**
Pay a supplier before the material arrives, and it sits on their account. When
the invoice comes in, apply the advance to it, in full or in part.

---

## Getting started

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install                # install dependencies
cp .env.example .env       # then open .env and set JWT_SECRET
npm run seed               # create the company, four users and the categories
npm start                  # http://localhost:3000
```

To see the screens filled with realistic figures before entering anything real:

```bash
npm run seed -- --demo
```

To wipe everything and start again:

```bash
npm run reset -- --force
```

### Sign in

Sign in with the short username or the full email address - either works.

| Role | Username | Email |
| --- | --- | --- |
| Owner | `admin` | owner@ararinfra.com |
| Finance Manager | `finance` | finance@ararinfra.com |
| Accountant 1 | `accountant1` | accountant1@ararinfra.com |
| Accountant 2 | `accountant2` | accountant2@ararinfra.com |

Passwords are never written in this repository. On a laptop, `npm run seed`
prints starter ones and you change them at first sign in. On a hosted copy they
come from the environment (`OWNER_PASSWORD` and friends) or are generated and
printed once to the deploy log.

Usernames can be changed per deployment with `OWNER_USERNAME`, `FINANCE_USERNAME`
and so on, or edited under Masters &rarr; Users.

### First things to set up

1. **Masters &rarr; Companies** - check the company name, and add another if the group
   takes a second licence. The short code appears in every payment and petty cash
   number, so keep it to three or four letters.
2. **Masters &rarr; Our bank accounts** - add the accounts money goes out from. These
   become the banks your cheques are drawn on.
3. **Masters &rarr; Suppliers** - name, their bank (used as the default for transfers)
   and the agreed credit period, chosen from the periods the group actually uses
   (immediate, 7, 15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180 days) or typed in
   for an unusual deal.
4. **Masters &rarr; Employees** - petty cash is always requested in an employee's name.
5. **Masters &rarr; Users** - change the passwords and decide which companies each
   accountant may work in.

---

## Who can do what

| | Owner | Finance Manager | Accountant |
| --- | :---: | :---: | :---: |
| Enter invoices, payments and petty cash requests | yes | yes | yes |
| See every company | yes | yes | only those assigned |
| Update a cheque status (cleared, bounced) | yes | yes | no |
| Put an invoice on hold | yes | yes | no |
| Delete an invoice or payment | yes | yes | no |
| Verify a petty cash request | yes | yes | no |
| **Approve petty cash** | **yes** | no | no |
| Pay out approved petty cash | yes | yes | no |
| Manage users | yes | no | no |
| Audit trail | yes | yes | no |

Nobody approves a request they raised themselves, whatever their role.

---

## How the work flows

### A supplier invoice

1. The invoice arrives. An accountant records the supplier, **their** invoice
   reference number, the invoice date and the date it was submitted to us.
2. The due date is worked out as *submitted date + payment terms*. The form shows
   it as you type. No submitted date means the clock has not started, and the
   invoice is listed under **Not submitted** so it does not get forgotten.
3. Once past the due date the row turns **red** on every screen, with the number of
   days late. Rows falling due within seven days turn amber.

### Paying it

Record a payment in whichever mode was used:

| Mode | What is captured |
| --- | --- |
| **Cash** | Nothing further |
| **Bank transfer** / **Online** | The supplier's bank name and account, the UTR, and **which of our banks it came out of** |
| **PDC** / **Cheque** | Cheque number, cheque date, and **which of our accounts it is drawn on** |

The group runs several bank accounts, so naming ours is required on transfers and
cheques - otherwise the cheque register cannot say what each bank is carrying.

Then tick the invoices it settles. *Fill oldest first* spreads the amount across
them automatically. Anything not applied stays on the supplier's account as an
advance, and the form tells you so before you save.

A cheque then moves through its life in the **Cheque register**:
issued &rarr; presented &rarr; cleared, or bounced, cancelled, replaced.
Only *cleared* reduces the payable.

### Folding supplier accounts together

A supplier list grown by hand in a spreadsheet collects the same company under
several spellings, and internal cost pools that turn out to be one related
business. **Masters &rarr; Suppliers &rarr; Merge** moves everything - invoices,
payments, bank facilities - onto one account and switches the others off.

Balances follow the invoices, so the group total never changes. Where the two
accounts used the same invoice number, both are kept and the incoming one is
marked with the code it came from rather than being dropped. Owner and finance
manager only.

### Payable by supplier and month

Supplier down the side, month across the top: the shape the group already kept by
hand. Each open invoice's outstanding amount is placed in the month its payment
falls due, worked out either way:

- **a fixed credit period** - invoices are treated as submitted on a chosen day of
  their submission month and paid a set number of days later. This is the planning
  view: everything submitted in August, on 90 day terms, is needed in November.
- **each invoice's own terms** - the real due date of each bill.

Both add up to the same total; they only disagree about which month the money is
needed in. Exports to CSV in the same layout.

### Bank facilities

Vehicle loans, equipment loans and letters of credit are entered once, with the
bank, the monthly instalment and the dates. The schedule of instalments is worked
out from that, and each one can be marked paid as the bank takes it. A vehicle
loan carries its plate number, so the cost can be traced back to the vehicle.

An LC is a single amount on its maturity date rather than a monthly instalment.

### What has to be paid this month

One screen answers the question the owner actually asks. Pick a month and it adds
up, for that month:

- **PDC issued** - cheques dated in the month and not yet cleared
- **STL settlement** - settlement cheques, counted separately from ordinary PDC
- **Bank EMI** - instalments on the vehicle and equipment loans
- **LC** - letters of credit maturing
- **Supplier invoices** - bills reaching their due date
- **Petty cash** - approved but not yet handed over

Where a cheque already covers an invoice falling due in the same month, the total
counts it once, not twice, and says so on screen.

### Petty cash

```
accounts raise it   ->  PENDING
finance verify it   ->  VERIFIED     (optional - the owner can approve straight away)
owner approves      ->  APPROVED     or REJECTED, with a reason
accounts pay it     ->  PAID
```

Every request names the employee it is for and the person who raised it. The full
trail - who verified, who approved, when, and any remarks - is on the request.
The sidebar shows a count of requests waiting on you.

---

## The screens

| Screen | What it is for |
| --- | --- |
| **What to pay** | Pick a month and see every commitment falling due in it: PDC, STL settlement, bank EMI, LC, supplier invoices and approved petty cash |
| **Dashboard** | Payable, PDC issued, still to arrange, overdue, cheques coming up, and a company by company table |
| **Supplier invoices** | Every bill, filtered by overdue, due soon, open or not submitted |
| **Payments** | Every payment, plus the advances still sitting on account |
| **Cheque register** | Cheques still to clear, by month and by bank, so the balance can be planned |
| **Petty cash** | Raise, verify, approve, reject and pay out |
| **Loans & LC** | Vehicle and equipment loans by monthly instalment, and letters of credit |
| **Income** | Customer invoices and money received |
| **Supplier ageing** | Each supplier split into not due / 1-30 / 31-60 / 61-90 / 90+ days late |
| **Supplier x month** | What each supplier is owed, placed in the month the cash falls due |
| **Group summary** | Every company side by side, with year to date figures |
| **Where money went** | The payment register for a period, broken down by mode |
| **Petty cash by staff** | Who drew how much, on what, and over which months |
| **Audit trail** | Every entry, edit, approval and deletion, with who did it |

Every list exports to CSV, and the reports print cleanly.

Use the **company selector** in the top bar to look at one company or the whole group.

---

## Adding suppliers from a spreadsheet

**Masters &rarr; Suppliers &rarr; Upload a list** takes an Excel or CSV file. Only
**Supplier name** is needed; code, contact, phone, email, TRN, credit period, bank,
account number, IBAN, address and notes are used when the sheet has them. Columns are
matched on what the heading says, so an existing list usually works as it is, and a
heading nobody recognises is reported rather than guessed at.

The file is read and the result shown - what would be added, what would be updated,
what would be skipped - before anything is written. A supplier already on file is
updated rather than added twice, and a column the sheet leaves blank keeps whatever
is already recorded.

## Bringing the old spreadsheet in

The purchase log can be loaded straight into the app:

```bash
npm run import -- PURCHASE_LOGS-2026.xlsx --dry-run          # see what it would do
npm run import -- PURCHASE_LOGS-2026.xlsx --company AIC      # do it
npm run import -- PURCHASE_LOGS-2026.xlsx --company AIC --cheques   # and the cheques
```

It reads the `Master_Combined` sheet (or `2026`): one row per supplier invoice,
with the invoice date, the date it was submitted, the terms, the amounts and what
has been paid. Suppliers and categories are created as it goes.

Where the sheet shows an amount already paid, that is recorded as a single opening
settlement against the invoice, so what is still outstanding in the app matches the
sheet's BALANCE column exactly. Historic cheques are not matched to individual
invoices - the sheet does not record which cheque paid which bill - so `--cheques`
only brings in the ones that have not cleared, as a register.

Running it twice is safe: an invoice already recorded for the same supplier is
skipped rather than duplicated.

## Moving data onto a hosted copy

The importer needs the spreadsheet on the same machine, which a hosted container
does not have. So import locally, then carry the result across:

1. Run the import against a local checkout, as above.
2. Sign in to the local copy as the owner, **Account &rarr; Download backup**.
3. Sign in to the hosted copy, **Account &rarr; Restore from a backup**, choose that
   file and type REPLACE.

Restoring replaces everything in the app. Whatever was there is saved to
`data/backups/` first, so a wrong file can be undone. The same screen is the way
back after a mistake: download a backup regularly and you can always return to it.

## Running it for real

The system is built to sit on the office network or behind the company VPN.

- **Set `JWT_SECRET`** in `.env` to a long random string. Without it everyone is
  signed out whenever the server restarts.
- **Back up `data/arar-accounts.db`.** That single file is the whole system.
  Copy it somewhere safe on a schedule.
- **Put it behind HTTPS** if it is reachable from outside the office, and set
  `NODE_ENV=production` so the session cookie is marked secure.
- Sessions last `SESSION_HOURS` (12 by default).

### Settings in `.env`

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | 3000 | Port the server listens on |
| `JWT_SECRET` | *(none)* | Signs the login sessions - set this |
| `SESSION_HOURS` | 12 | How long a sign in lasts |
| `DB_FILE` | ./data/arar-accounts.db | Where the database lives |
| `GROUP_NAME` | ARAR INFRA GROUP | Shown on the group report |
| `DEFAULT_CURRENCY` | AED | Currency used throughout |
| `DEFAULT_PAYMENT_TERMS_DAYS` | 90 | Credit period for a new supplier |
| `DATA_DIR` | ./data | Where the database and session secret live - point this at a mounted volume when hosting |
| `OWNER_PASSWORD` etc. | *(none)* | Set a password from the host's variables; reapplied on every start, so remove it once people manage their own |
| `OWNER_USERNAME` etc. | admin, finance, accountant1, accountant2 | The name each person types to sign in |

---

## Checking it still works

```bash
npm test
```

82 end-to-end checks across three files. `test/smoke.js` covers the rules that
matter: terms counted from the
submitted date, overdue flagging, a cheque staying a commitment until it clears
and going back onto the payable when it bounces, allocations never exceeding what
an invoice owes, advances applied later, petty cash needing somebody other than
the requester to approve, and each role being held to its permissions.

`test/hosted.js` covers what changes once the app is hosted: first-run accounts,
weak passwords never reaching a deployment, storage surviving a redeploy, the sign
in throttle, who may take a backup, and that restoring one replaces the data,
keeps a copy of what it replaced and leaves the app usable.

`test/facilities.js` covers the monthly view: instalment schedules, an instalment
dated the 31st landing on the last day of February, LCs falling due once, PDC and
STL counted apart, and money covered by a cheque not being asked for twice.

---

## How it is built

Node.js and Express on the back, SQLite for storage, and plain HTML, CSS and
JavaScript on the front - no build step, no bundler, nothing to compile.

```
src/
  server.js      the Express app
  schema.sql     the database
  db.js          connection, document numbering, audit trail
  auth.js        passwords, sessions, roles and permissions
  queries.js     the payable / PDC / ageing calculations
  util.js        dates, money, due dates, ageing buckets
  config.js      where data lives, and the session secret
  bootstrap.js   first boot on a hosted deployment
  migrations.js  schema changes for databases made by an earlier version
  ratelimit.js   the sign in throttle
  import.js      loads the old purchase log spreadsheet
  set-password.js the way back in when nobody can sign in
  seed.js        first run setup and the sample data
  routes/        auth, masters, purchases, payments, sales, pettycash,
                 facilities, reports, admin
public/
  index.html     the single page
  css/app.css    one stylesheet
  img/           drop logo.png here and it appears on sign in and the sidebar
  js/            core, dashboard, payables, petty, monthly, income, reports,
                 masters, app
test/smoke.js    the end-to-end checks
```

Amounts are stored rounded to two decimals, and dates as plain `YYYY-MM-DD`
text, so the database reads the same way the screens do.
