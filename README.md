# Investment Monitor (RMB Ledger)

A two-page frontend ledger for shared investing:

- `index.html`: dashboard (display)
- `operation.html`: edit / operations

Now supports **shared cloud storage via Supabase** (optional). If cloud is not configured, it still works with local browser storage.

## Files

- `index.html`: display page
- `operation.html`: operation page
- `styles.css`: styles
- `app.js`: UI logic + calculations + sync flow
- `storage.js`: local persistence + optional Supabase persistence
- `config.js`: runtime config (Supabase URL/key/row id)
- `config.example.js`: config template

## Quick Start (Local-only)

1. Open `/Users/chaos/Codes/invest_monitor/index.html`.
2. Go to operation page and edit data.
3. Data is saved in localStorage.

## Enable Shared Cloud Data (Supabase)

### 1. Create Supabase project

Create a project at [Supabase](https://supabase.com/).

### 2. Create table

Run this SQL in Supabase SQL Editor:

```sql
create table if not exists public.ledger_states (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
```

### 3. Allow browser read/write (simple setup)

For personal/internal use, run:

```sql
alter table public.ledger_states enable row level security;

create policy "anon can read ledger_states"
on public.ledger_states
for select
to anon
using (true);

create policy "anon can write ledger_states"
on public.ledger_states
for insert
to anon
with check (true);

create policy "anon can update ledger_states"
on public.ledger_states
for update
to anon
using (true)
with check (true);
```

### 4. Fill config

Edit `/Users/chaos/Codes/invest_monitor/config.js`:

```js
window.LEDGER_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
  stateRowId: "shared-ledger",
};
```

Notes:

- `stateRowId` must be the same for both devices/users.
- `anon key` is a public key, but keep project policies minimal and controlled.

### 5. Verify

- Open operation page on your device, edit any field.
- Open dashboard page on partner device (same deployed URL), refresh.
- Both should see same data.

## Deploy (Simplest)

### Option A: GitHub Pages

1. Push repo to GitHub.
2. Repo `Settings -> Pages`.
3. Source: `Deploy from a branch`.
4. Branch: `main`, folder: `/root`.
5. Wait for the Pages URL.

### Option B: Vercel

1. Import the GitHub repo into Vercel.
2. Framework preset: `Other`.
3. Deploy directly (no build command needed).

## Current Calculation Notes

- Net value is **stock-account-only**:
  - `净值 = 股票资产快照 / 总本金`
- Total profit is holdings-based:
  - `总收益 = 股票持仓总浮盈 + 基金持仓总浮盈`
- Today profit is based on the day baseline of profit metrics.

## Troubleshooting

- If dashboard/operation shows old values, hard refresh (`Cmd+Shift+R`).
- If cloud sync fails, check:
  - `config.js` values
  - Supabase table/policies
  - browser console error logs
- Without cloud config, app stays local-only by design.
