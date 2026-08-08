# Marblehouse

Pinball arcade management — sales, cross-branch marble and ticket balances,
FIFO prize inventory, staff attendance, expenses and reporting.

Self-hosted. Runs on one machine you control, reachable from every branch
through a Cloudflare Tunnel. No cloud platform, no Vercel.

- **Full specification:** [`docs/PRD.md`](docs/PRD.md)
- **Rules for the coding agent:** [`CLAUDE.md`](CLAUDE.md)
- **Status:** Phases 0–3, 5, 7 and 8 complete on a development machine.
  Phases 4 (prizes, FIFO inventory, redemption), 6 (attendance) and 9 (backup
  and restore) are built and verified on dev — engines, APIs and screens — but
  **not signed off**. Each needs a hands-on acceptance pass:

  | Phase | What is still needed |
  |---|---|
  | 4 | A staff member using the redemption flow on the actual tablet |
  | 6 | A clock-in on a real device, location granted **and** denied — the camera and geolocation prompts genuinely cannot be tested any other way |
  | 9 | **A full restore onto a second machine**, rehearsed start to finish |

  All three are hands-on and can be done in one sitting. Phase 10 (polish and
  pilot) is next after that.

---

## First run on your Mac

You need Node 22, Git and PostgreSQL 16 — **no Docker.** This Mac already has
Homebrew Postgres 16, the same major version production runs.

```bash
cd ~/redlight
createdb marblehouse_dev
npm install
npm run db:migrate        # creates the first migration and seeds
npm run dev
```

Open http://localhost:5050 — you should see shop, user and category counts.
A red database error means `DATABASE_URL` in `.env` is wrong; it should be
`postgresql://ricky@localhost:5432/marblehouse_dev`.

> **Why 5050?** Port 3000 belongs to another project on this Mac, and macOS
> claims 5000 for AirPlay Receiver. To change it, edit the `dev` and `start`
> scripts in `package.json`, `PORT`/`APP_URL` in `.env`, and the port lines in
> `Dockerfile` and `docker-compose.yml`.

Useful while developing:

```bash
npm run db:studio         # browse the data in a GUI
npm run typecheck
npm test                  # unit + integration tests (FIFO, transfers, attendance)
npm run db:reset          # wipe and re-seed when the schema churns

npm run db:seed -- --demo        # add a realistic 60-day dataset
npm run db:seed -- --reset-demo  # remove it again, leaving your real data
```

**The demo dataset** gives the dashboards and reports something to show: three
extra branches, 200 customers, ~1700 sales, prize batches, redemptions and 60
days of attendance. It is generated from a **fixed random seed**, so the same
command always produces the same numbers — which is what makes it possible to
check a report by hand and trust the answer next week.

Both flags refuse to run against anything but a `_dev` or `_test` database.
Every row is tagged, and `--reset-demo` removes exactly those.

`npm test` runs against your **development database** rather than a mock,
because the rules it checks — FIFO order, "stock can never go negative" — are
enforced by PostgreSQL itself. Each test rolls back or cleans up after itself,
so a full run leaves no rows behind, and it refuses to start against a database
whose name does not contain `_dev` or `_test`.

Docker is only used for the production deployment (next section). If you ever
work on a machine without Postgres installed, `docker-compose.dev.yml` will
start one on port **5433** — deliberately not 5432, so it cannot collide with
a local server.

### The one Docker check you should still run

Before finishing each phase, build the production image once:

```bash
docker compose build
```

macOS ignores filename case and Linux does not, so an import typo like
`./components/button` vs `./components/Button` works on your Mac and fails
only inside the Linux container. This is the cheapest way to catch it — much
better than discovering it during a deploy. It needs Docker Desktop installed,
but nothing has to keep running.

---

## Your login

Username and password are in `.env` as `SEED_OWNER_USERNAME` and
`SEED_OWNER_PASSWORD`. You will be forced to change the password on first
login once Phase 1 exists.

`.env` is gitignored and contains generated secrets. **Generate new ones for
the production machine** — do not reuse these.

## Dev vs production, at a glance

|  | Mac (dev) | Windows (production) |
|---|---|---|
| Postgres | Homebrew, `localhost:5432` | Docker, `postgres:5432` |
| App | `npm run dev` | Docker container |
| `DATABASE_URL` | `...@localhost:5432/marblehouse_dev` | `...@postgres:5432/marblehouse` |
| `NODE_ENV` | `development` | `production` |
| Migrations | `npm run db:migrate` — creates them | `migrate deploy` — applies only |
| Tunnel | none | `cloudflared`, `--profile tunnel` |

Both `DATABASE_URL` lines live in `.env`, one commented out. Swap them when
you set up the Windows machine.

---

## Deploying to the Windows machine

Install Docker Desktop (WSL2 backend) and Git, then:

```bash
git clone <your-repo> marblehouse
cd marblehouse
cp .env.example .env
```

Fill in `.env` with **fresh** secrets:

```bash
openssl rand -hex 24    # POSTGRES_PASSWORD
openssl rand -hex 32    # SESSION_SECRET
```

Set `APP_URL` to your real hostname, `TRUST_PROXY=true`, and paste your
`CLOUDFLARE_TUNNEL_TOKEN`. Then:

```bash
docker compose --profile tunnel up -d --build
```

In Docker Desktop, enable *Start Docker Desktop when you log in*, and set the
machine to power on automatically after AC loss. Otherwise a power cut takes
every branch offline until someone is physically there.

### Ongoing updates

```bash
git pull
docker compose up -d --build
```

Migrations apply on start. **Never create a migration on this machine** — make
them on the Mac and commit them.

---

## Backups — and the one thing you must actually do

Backups run automatically at **02:00** into `backups/`, keeping the last 7.
Each archive holds a full database dump, your attendance photos and receipts,
and a manifest with per-table row counts and checksums.

```bash
npm run backup            # take one now, from the shell
```

**The automatic part is not the part that saves you.** The backups sit on the
same machine as the database, so a dead disk takes both. Copying an archive off
the machine is manual, by your own decision — so the app makes it one tap and
nags you about it:

1. **Settings → Backups → Download latest backup.**
2. Copy it to a USB drive or cloud storage.
3. Tap **"I copied this off-machine."**

The dashboard turns amber after 7 days without that tap and **red after 14**,
and the red warning cannot be dismissed. That is deliberate — it is the only
thing standing between you and losing every sale, balance and attendance record
the business has.

> Archives are **not encrypted** and contain customer names, phone numbers and
> password hashes. Keep the copies somewhere you control. (This was a
> deliberate choice — see BUILD-LOG D-71 — and can be turned on later.)

### Restoring

```bash
./scripts/restore.sh backups/marblehouse-2026-08-03-0200.tar.gz
```

It verifies the checksum, **refuses to overwrite a database that already has
data** unless you pass `--force`, and finishes by printing a row-by-row
comparison against the manifest. If anything is short, it fails loudly rather
than leaving you with a restore that quietly lost 5% of your sales.

**Rehearse this once on a second machine before you go live.** A backup you
have never restored is a backup you are guessing about.

## Layout

```
prisma/schema.prisma     data model — the contract everything else follows
prisma/seed.ts           idempotent seed; runs on every boot
src/app/                 routes and UI
src/app/api/             REST endpoints (auth → validate → call a service)
src/server/services/     ALL business logic lives here
src/server/dto/          response shapes — where cost figures are gated
src/lib/                 money, business date, phone normalisation
data/                    attendance photos, receipts  (gitignored)
backups/                 database backups              (gitignored)
```

`data/` and `backups/` hold customer names, phone numbers and staff photos.
They are gitignored deliberately — keep them out of GitHub.

---

## Ground rules worth remembering

- Money is `Decimal`, never a JavaScript number.
- On-hand stock is always summed from batches; there is no quantity column.
- Cost figures never reach a manager or staff session.
- Every sale endpoint is idempotent — staff double-tap on slow wifi.
- Back up off-machine. A backup that lives only on the machine that broke is
  not a backup.
