(function initLedgerCore(global) {
  const storage = global.LedgerStorage || {};
  const number = typeof storage.number === "function" ? storage.number : (value) => Number(value) || 0;

  function round(value, precision = 6) {
    const factor = 10 ** precision;
    return Math.round(number(value) * factor) / factor;
  }

  function normalizeCode(code) {
    return String(code || "").trim().toUpperCase();
  }

  function normalizeMembers(rawMembers) {
    const source = Array.isArray(rawMembers) ? rawMembers : [];
    const output = [];
    const seen = new Set();

    source.forEach((item, index) => {
      const member = item && typeof item === "object" ? item : {};
      const id = String(member.id || member.memberId || `member-${index + 1}`).trim() || `member-${index + 1}`;
      const name = String(member.name || "").trim() || `成员${index + 1}`;
      if (seen.has(id)) return;
      seen.add(id);
      output.push({ id, name });
    });

    return output;
  }

  function sortByTimeAsc(rows) {
    return [...rows].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  function computeHoldings(trades, prices, members) {
    const priceMap = prices && typeof prices === "object" ? prices : {};
    const map = new Map();
    let totalBuyAmount = 0;
    let totalSellAmount = 0;

    sortByTimeAsc(trades).forEach((trade) => {
      const code = normalizeCode(trade.code);
      if (!code) return;

      const quantity = Math.max(0, number(trade.quantity));
      const price = Math.max(0, number(trade.price));
      if (quantity <= 0 || price <= 0) return;

      const amount = quantity * price;
      const current = map.get(code) || {
        code,
        name: String(trade.name || code),
        quantity: 0,
        costValue: 0,
        lastTradePrice: price,
      };

      current.name = String(trade.name || current.name || code).trim() || code;
      current.lastTradePrice = price;

      if (trade.type === "sell") {
        if (current.quantity > 0) {
          const sellQty = Math.min(current.quantity, quantity);
          const avgCost = current.quantity > 0 ? current.costValue / current.quantity : 0;
          current.quantity -= sellQty;
          current.costValue = Math.max(0, current.costValue - avgCost * sellQty);
          totalSellAmount += sellQty * price;
        }
      } else {
        current.quantity += quantity;
        current.costValue += amount;
        totalBuyAmount += amount;
      }

      map.set(code, current);
    });

    const holdings = [...map.values()]
      .filter((row) => row.quantity > 1e-8)
      .map((row) => {
        const code = row.code;
        const quantity = round(row.quantity, 6);
        const costValue = round(row.costValue, 6);
        const avgCost = quantity > 0 ? costValue / quantity : 0;
        const currentPrice = number(priceMap[code]) > 0 ? number(priceMap[code]) : number(row.lastTradePrice);
        const marketValue = quantity * currentPrice;
        const pnl = marketValue - costValue;

        return {
          code,
          name: row.name,
          quantity,
          avgCost: round(avgCost, 6),
          currentPrice: round(currentPrice, 6),
          costValue: round(costValue, 6),
          marketValue: round(marketValue, 6),
          pnl: round(pnl, 6),
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code, "zh-CN"));

    return {
      holdings,
      totalBuyAmount: round(totalBuyAmount, 6),
      totalSellAmount: round(totalSellAmount, 6),
    };
  }

  function computeSummary(state) {
    const source = state && typeof state === "object" ? state : {};
    const members = normalizeMembers(source.members);

    const validMemberIds = new Set(members.map((member) => member.id));

    const subscriptions = sortByTimeAsc(Array.isArray(source.subscriptions) ? source.subscriptions : [])
      .map((item) => {
        const raw = item && typeof item === "object" ? item : {};
        const memberId = String(raw.memberId || "").trim();
        return {
          id: String(raw.id || ""),
          memberId,
          amount: Math.max(0, number(raw.amount)),
          shares: Math.max(0, number(raw.shares)),
          navAtSubscription: Math.max(0, number(raw.navAtSubscription)),
          at: raw.at || new Date().toISOString(),
          note: String(raw.note || "").trim(),
        };
      })
      .filter((row) => validMemberIds.has(row.memberId) && row.amount > 0 && row.shares > 0);

    const withdrawals = sortByTimeAsc(Array.isArray(source.withdrawals) ? source.withdrawals : [])
      .map((item) => {
        const raw = item && typeof item === "object" ? item : {};
        const memberId = String(raw.memberId || "").trim();
        return {
          id: String(raw.id || ""),
          memberId,
          amount: Math.max(0, number(raw.amount)),
          shares: Math.max(0, number(raw.shares)),
          navAtWithdrawal: Math.max(0, number(raw.navAtWithdrawal)),
          at: raw.at || new Date().toISOString(),
          note: String(raw.note || "").trim(),
        };
      })
      .filter((row) => validMemberIds.has(row.memberId) && row.amount > 0 && row.shares > 0);

    const trades = sortByTimeAsc(Array.isArray(source.trades) ? source.trades : [])
      .map((item) => {
        const raw = item && typeof item === "object" ? item : {};
        return {
          id: String(raw.id || ""),
          type: raw.type === "sell" ? "sell" : "buy",
          code: normalizeCode(raw.code),
          name: String(raw.name || "").trim(),
          price: Math.max(0, number(raw.price)),
          quantity: Math.max(0, number(raw.quantity)),
          sourceMemberId: String(raw.sourceMemberId || "pool").trim() || "pool",
          at: raw.at || new Date().toISOString(),
          note: String(raw.note || "").trim(),
        };
      })
      .filter((row) => row.code && row.price > 0 && row.quantity > 0);

    const investedByMember = {};
    const sharesByMember = {};
    members.forEach((member) => {
      investedByMember[member.id] = 0;
      sharesByMember[member.id] = 0;
    });

    subscriptions.forEach((sub) => {
      investedByMember[sub.memberId] += sub.amount;
      sharesByMember[sub.memberId] += sub.shares;
    });

    withdrawals.forEach((wd) => {
      investedByMember[wd.memberId] -= wd.amount;
      sharesByMember[wd.memberId] -= wd.shares;
    });

    const totalSubscribedAmount = round(subscriptions.reduce((sum, sub) => sum + sub.amount, 0), 6);
    const totalWithdrawnAmount = round(withdrawals.reduce((sum, wd) => sum + wd.amount, 0), 6);
    const totalInvested = round(totalSubscribedAmount - totalWithdrawnAmount, 6);

    const totalSubscribedShares = round(subscriptions.reduce((sum, sub) => sum + sub.shares, 0), 8);
    const totalWithdrawnShares = round(withdrawals.reduce((sum, wd) => sum + wd.shares, 0), 8);
    const totalShares = round(Math.max(0, totalSubscribedShares - totalWithdrawnShares), 8);

    const holdingResult = computeHoldings(trades, source.prices, members);
    const holdings = holdingResult.holdings;

    const holdingMarketValueTotal = round(holdings.reduce((sum, row) => sum + row.marketValue, 0), 6);
    const holdingCostTotal = round(holdings.reduce((sum, row) => sum + row.costValue, 0), 6);
    const holdingPnlTotal = round(holdings.reduce((sum, row) => sum + row.pnl, 0), 6);

    const cash = round(totalInvested - holdingResult.totalBuyAmount + holdingResult.totalSellAmount, 6);
    const totalAsset = round(cash + holdingMarketValueTotal, 6);
    const nav = totalShares > 0 ? round(totalAsset / totalShares, 8) : 1;

    const memberRows = members.map((member) => {
      const invested = round(investedByMember[member.id], 6);
      const shares = round(Math.max(0, sharesByMember[member.id]), 8);
      const ownershipRatio = totalShares > 0 ? shares / totalShares : 0;
      const asset = round(shares * nav, 6);
      const totalProfit = round(asset - invested, 6);
      const holdingCostShare = round(holdingCostTotal * ownershipRatio, 6);
      const holdingMarketShare = round(holdingMarketValueTotal * ownershipRatio, 6);
      const holdingProfitShare = round(holdingMarketShare - holdingCostShare, 6);

      return {
        id: member.id,
        name: member.name,
        invested,
        shares,
        ownershipRatio,
        asset,
        totalProfit,
        holdingCostShare,
        holdingMarketShare,
        holdingProfitShare,
      };
    });

    const totalProfit = round(memberRows.reduce((sum, member) => sum + member.totalProfit, 0), 6);

    const tradeRows = [...trades].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const subscriptionRows = [...subscriptions].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const withdrawalRows = [...withdrawals].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return {
      members,
      subscriptions,
      withdrawals,
      trades,
      holdings,
      memberRows,
      totalInvested,
      totalSubscribedAmount,
      totalWithdrawnAmount,
      totalShares,
      totalSubscribedShares,
      totalWithdrawnShares,
      cash,
      nav,
      totalAsset,
      totalProfit,
      holdingMarketValueTotal,
      holdingCostTotal,
      holdingPnlTotal,
      tradeRows,
      subscriptionRows,
      withdrawalRows,
      buyAmountTotal: holdingResult.totalBuyAmount,
      sellAmountTotal: holdingResult.totalSellAmount,
    };
  }

  function createDailyBaseline(summary) {
    const memberAssets = {};
    const memberInvested = {};
    summary.memberRows.forEach((member) => {
      memberAssets[member.id] = round(member.asset, 6);
      memberInvested[member.id] = round(member.invested, 6);
    });

    return {
      at: new Date().toISOString(),
      totalAsset: round(summary.totalAsset, 6),
      memberAssets,
      memberInvested,
    };
  }

  global.LedgerCore = {
    round,
    normalizeCode,
    normalizeMembers,
    computeSummary,
    createDailyBaseline,
  };
})(window);
