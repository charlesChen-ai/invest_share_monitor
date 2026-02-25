# Investment Monitor (RMB Ledger)

A lightweight frontend ledger for shared stock investing, designed for two people to track:

- principal split
- current total assets and net value
- holdings (manual quantity/cost, optional real-time price refresh)
- per-person assets/profit
- cash + reconciliation gap
- deposit/withdraw handling based on net value
- operation history

All data is persisted in browser `localStorage`, so reopening the page keeps your latest state.

## Files

- `index.html`: dashboard / demonstration page (read-focused)
- `operation.html`: operation page (edit, holdings maintenance, capital operations)
- `styles.css`: UI styling and responsive layout
- `app.js`: calculations, persistence, quote refresh, capital operations, logs

## Run

1. Open `index.html` for the dashboard view.
2. Click `进入操作页` to edit data and execute operations.
3. All updates auto-save to `localStorage`.

No backend or dependency install is required.

## Main Features

### 1) RMB Ledger + Net Value

- `当前净值 = 当前总资产 / 总本金`
- per-person asset is calculated by net value and principal share
- calculated metrics show result first; click the metric to expand its formula/details
- dashboard and operation flows are separated into different pages

### 2) Holdings

Each row tracks:

- stock code / name
- quantity
- average cost
- current price
- market value
- cost value
- unrealized PnL

You can update current price manually, or use:

- row-level `实时价`
- bulk `刷新全部实时价`

Quote refresh requires internet access from the browser.

### 3) Capital Operation Logic (Deposit / Withdraw)

After principal is established, principal is not edited directly in the snapshot form.
Use the capital operation section:

- action: `入金` or `出金`
- target: proportional / member A / member B
- amount
- optional note

Core formula for both directions:

- `本金份额变化 = 操作金额 / 当前净值`

Then:

- `入金`: increase principal share and increase total asset
- `出金`: decrease principal share and decrease total asset

This keeps net-value accounting consistent over time.

### 4) Operation History

Important actions are appended to a persistent log, including:

- manual save
- holdings add/remove
- quote refresh
- deposit / withdraw
- clear history

## Edit-Time Rule

- There is no manual edit-time input.
- Snapshot saves and capital operations always use current system time as `更新时间`.

## Data Persistence

- Storage key: `equity_ledger_rmb_v2`
- Stored in browser `localStorage`
- Clearing browser site data will remove saved records

## Notes

- This is a local tracking tool, not brokerage reconciliation.
- Real-time quote source can fail depending on network/provider availability; manual price entry remains available.
