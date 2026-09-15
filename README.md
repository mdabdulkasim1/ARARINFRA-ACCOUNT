# ARAR INFRA &middot; Accounts

An internal cash-out control system for the six companies of the ARAR INFRA group.

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
npm run seed               # create the six companies, four users and the categories
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

`npm run seed` prints these. **Change every password the first time you sign in** -
the system will prompt you to.

| Role | Email | Password |
| --- | --- | --- |
| Owner | owner@ararinfra.com | Owner@2026 |
| Finance Manager | finance@ararinfra.com | Finance@2026 |
| Accountant 1 | accountant1@ararinfra.com | Accounts@2026 |
| Accountant 2 | accountant2@ararinfra.com | Accounts@2026 |

### First things to set up

1. **Masters &rarr; Companies** - rename the six companies. The short code appears in
   every payment and petty cash number, so keep it to three or four letters.
2. **Masters &rarr; Our bank accounts** - add the accounts money goes out from. These
   become the banks your cheques are drawn on.
3. **Masters &rarr; Suppliers** - name, their bank (used as the default for transfers)
   and the agreed credit period.
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
| **Bank transfer** / **Online** | The supplier's bank name and account, our paying account, and the UTR |
| **PDC** / **Cheque** | Cheque number, cheque date, and the bank it is drawn on |

Then tick the invoices it settles. *Fill oldest first* spreads the amount across
them automatically. Anything not applied stays on the supplier's account as an
advance, and the form tells you so before you save.

A cheque then moves through its life in the **Cheque register**:
issued &rarr; presented &rarr; cleared, or bounced, cancelled, replaced.
Only *cleared* reduces the payable.

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
| **Dashboard** | Payable, PDC issued, still to arrange, overdue, cheques coming up, and a company by company table |
| **Supplier invoices** | Every bill, filtered by overdue, due soon, open or not submitted |
| **Payments** | Every payment, plus the advances still sitting on account |
| **Cheque register** | Cheques still to clear, by month and by bank, so the balance can be planned |
| **Petty cash** | Raise, verify, approve, reject and pay out |
| **Income** | Customer invoices and money received |
| **Supplier ageing** | Each supplier split into not due / 1-30 / 31-60 / 61-90 / 90+ days late |
| **Group summary** | All six companies side by side, with year to date figures |
| **Where money went** | The payment register for a period, broken down by mode |
| **Petty cash by staff** | Who drew how much, on what, and over which months |
| **Audit trail** | Every entry, edit, approval and deletion, with who did it |

Every list exports to CSV, and the reports print cleanly.

Use the **company selector** in the top bar to look at one company or the whole group.

---

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

---

## Checking it still works

```bash
npm test
```

43 end-to-end checks covering the rules that matter: terms counted from the
submitted date, overdue flagging, a cheque staying a commitment until it clears
and going back onto the payable when it bounces, allocations never exceeding what
an invoice owes, advances applied later, petty cash needing somebody other than
the requester to approve, and each role being held to its permissions.

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
  seed.js        first run setup and the sample data
  routes/        auth, masters, purchases, payments, sales, pettycash, reports
public/
  index.html     the single page
  css/app.css    one stylesheet
  js/            core, dashboard, payables, petty, income, reports, masters, app
test/smoke.js    the end-to-end checks
```

Amounts are stored rounded to two decimals, and dates as plain `YYYY-MM-DD`
text, so the database reads the same way the screens do.
