/**
 * FINODHA: ZERODHA-STYLE MARGIN LOAN & PORTFOLIO LEDGER
 * Frontend Application Controller & Real-Time Engine
 */

// Global State
const state = {
  token: localStorage.getItem('finodha_jwt') || null,
  user: null,
  portfolio: null,
  instruments: [],
  loans: [],
  ledgerEntries: [],
  ws: null,
  donutChart: null,
  activeRepayLoan: null,
  activePledgeHolding: null,
  activeOrderInstrument: null,
  orderSide: 'BUY'
};

const API_BASE = '/api';

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initNavigation();
  initModals();
  initShockSimulator();

  // If no auth token, auto-authenticate with demo user for seamless zero-setup evaluation
  if (!state.token) {
    await autoDemoLogin();
  } else {
    try {
      await fetchUserProfile();
    } catch (e) {
      await autoDemoLogin();
    }
  }

  // Load core data
  await loadMarketInstruments();
  await refreshPortfolio();
  await loadLoans();
  await loadLedger();

  // Connect WebSocket live price stream
  connectWebSocket();

  // Render icons
  if (window.lucide) {
    window.lucide.createIcons();
  }
});

// ============================================================================
// AUTHENTICATION & SESSION
// ============================================================================

async function autoDemoLogin() {
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'abhishek@finodha.trade', password: 'demo1234' })
    });
    const data = await res.json();
    if (data.success) {
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('finodha_jwt', data.token);
      updateUserUI();
    }
  } catch (err) {
    console.error('Demo login error:', err);
  }
}

async function fetchUserProfile() {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { 'Authorization': `Bearer ${state.token}` }
  });
  if (!res.ok) throw new Error('Token expired');
  const data = await res.json();
  state.user = data.user;
  updateUserUI();
}

function updateUserUI() {
  if (!state.user) return;
  document.getElementById('navClientId').textContent = state.user.client_id || state.user.clientId;
  document.getElementById('navClientName').textContent = state.user.name;
  
  const initials = state.user.name.split(' ').map(n => n[0]).join('').substring(0, 2);
  document.getElementById('userAvatar').textContent = initials;
}

// ============================================================================
// THEME & NAVIGATION
// ============================================================================

function initTheme() {
  const savedTheme = localStorage.getItem('finodha_theme') || 'theme-light';
  document.body.className = savedTheme;

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const isDark = document.body.classList.contains('theme-dark');
    const newTheme = isDark ? 'theme-light' : 'theme-dark';
    document.body.className = newTheme;
    localStorage.setItem('finodha_theme', newTheme);
    if (state.donutChart) renderCollateralDonut(); // Re-render chart for theme colors
  });

  // Logout handler
  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('finodha_jwt');
    location.reload();
  });
}

function initNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      
      navBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active');
      });

      const activePane = document.getElementById(`tab-${targetTab}`);
      if (activePane) activePane.classList.add('active');

      if (targetTab === 'ledger') loadLedger();
      if (targetTab === 'loans') loadLoans();
      if (targetTab === 'holdings') refreshPortfolio();

      if (window.lucide) window.lucide.createIcons();
    });
  });
}

// ============================================================================
// REAL-TIME WEBSOCKET FEED
// ============================================================================

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    const statusEl = document.getElementById('wsStatus');
    statusEl.innerHTML = '<span class="pulse-dot"></span><span class="status-text">LIVE TICKER</span>';
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'PRICE_UPDATE' && Array.isArray(data.ticks)) {
        updateMarketwatchTicks(data.ticks);
        // Periodically refresh portfolio metrics with live tick updates
        debouncedRefreshPortfolio();
      }
    } catch (e) {}
  };

  state.ws.onclose = () => {
    const statusEl = document.getElementById('wsStatus');
    statusEl.innerHTML = '<span style="color:#f6465d">● RECONNECTING</span>';
    setTimeout(connectWebSocket, 4000);
  };
}

let refreshTimer = null;
function debouncedRefreshPortfolio() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshPortfolio(false);
    refreshTimer = null;
  }, 4000);
}

// ============================================================================
// MARKETWATCH SIDEBAR
// ============================================================================

async function loadMarketInstruments() {
  try {
    const res = await fetch(`${API_BASE}/market/instruments`);
    const data = await res.json();
    if (data.success) {
      state.instruments = data.instruments;
      renderMarketwatchList(data.instruments);
    }
  } catch (err) {
    console.error('Error loading instruments:', err);
  }
}

function renderMarketwatchList(instruments) {
  const container = document.getElementById('mwList');
  container.innerHTML = '';

  instruments.forEach(inst => {
    const isPos = inst.day_change >= 0;
    const item = document.createElement('div');
    item.className = 'mw-item';
    item.id = `mw-row-${inst.symbol}`;

    item.innerHTML = `
      <div class="mw-stock-info">
        <div class="mw-stock-name">
          <span>${inst.symbol}</span>
          <span class="mw-haircut-badge" title="SEBI Collateral Haircut">${inst.haircut_pct}% HC</span>
        </div>
        <div class="mw-stock-sub">${inst.exchange} • ${inst.category.replace('_', ' ')}</div>
      </div>

      <div class="mw-price-info">
        <span class="mw-price" id="mw-price-${inst.symbol}">₹${inst.current_price.toFixed(2)}</span>
        <span class="mw-change ${isPos ? 'pos' : 'neg'}" id="mw-change-${inst.symbol}">
          ${isPos ? '+' : ''}${inst.day_change.toFixed(2)} (${isPos ? '+' : ''}${inst.day_change_pct.toFixed(2)}%)
        </span>
      </div>

      <div class="mw-actions">
        <button class="mw-btn b-buy" onclick="openOrderModal('${inst.symbol}', 'BUY')">B</button>
        <button class="mw-btn b-sell" onclick="openOrderModal('${inst.symbol}', 'SELL')">S</button>
        <button class="mw-btn b-pledge" onclick="openPledgeModalForSymbol('${inst.symbol}')" title="Pledge Collateral">Pledge</button>
      </div>
    `;

    container.appendChild(item);
  });

  // Search filter
  document.getElementById('mwSearchInput').addEventListener('input', (e) => {
    const q = e.target.value.toUpperCase();
    const rows = container.querySelectorAll('.mw-item');
    rows.forEach(r => {
      r.style.display = r.id.includes(q) ? 'flex' : 'none';
    });
  });
}

function updateMarketwatchTicks(ticks) {
  ticks.forEach(tick => {
    const priceEl = document.getElementById(`mw-price-${tick.symbol}`);
    const changeEl = document.getElementById(`mw-change-${tick.symbol}`);
    const rowEl = document.getElementById(`mw-row-${tick.symbol}`);

    if (priceEl && rowEl) {
      const oldPrice = parseFloat(priceEl.textContent.replace('₹', ''));
      const newPrice = tick.current_price;

      priceEl.textContent = `₹${newPrice.toFixed(2)}`;
      const isPos = tick.day_change >= 0;
      changeEl.className = `mw-change ${isPos ? 'pos' : 'neg'}`;
      changeEl.textContent = `${isPos ? '+' : ''}${tick.day_change.toFixed(2)} (${isPos ? '+' : ''}${tick.day_change_pct.toFixed(2)}%)`;

      // Flash animation
      if (newPrice > oldPrice) {
        rowEl.classList.remove('tick-down');
        rowEl.classList.add('tick-up');
        setTimeout(() => rowEl.classList.remove('tick-up'), 600);
      } else if (newPrice < oldPrice) {
        rowEl.classList.remove('tick-up');
        rowEl.classList.add('tick-down');
        setTimeout(() => rowEl.classList.remove('tick-down'), 600);
      }
    }
  });
}

// ============================================================================
// PORTFOLIO & REAL-TIME COLLATERAL MONITORING
// ============================================================================

async function refreshPortfolio(renderHoldingsTable = true) {
  if (!state.token) return;

  try {
    const res = await fetch(`${API_BASE}/portfolio`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const result = await res.json();
    if (!result.success) return;

    state.portfolio = result.data;
    const m = state.portfolio.metrics;

    // 1. Update Dashboard Metric Cards
    document.getElementById('dashTotalPortfolio').textContent = `₹${m.grossPortfolioValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    
    const pnlPos = m.totalUnrealizedPnl >= 0;
    const pnlEl = document.getElementById('dashPortfolioPnl');
    pnlEl.className = `metric-sub ${pnlPos ? 'text-green' : 'text-red'}`;
    pnlEl.textContent = `Unrealized P&L: ${pnlPos ? '+' : ''}₹${m.totalUnrealizedPnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })} (${pnlPos ? '+' : ''}${m.totalUnrealizedPnlPct.toFixed(2)}%)`;

    document.getElementById('dashCollateralVal').textContent = `₹${m.eligibleCollateralValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('dashPledgedGross').textContent = `₹${m.grossPledgedValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('dashAvailableMargin').textContent = `₹${m.availableMarginToBorrow.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('dashMaxBorrow').textContent = `₹${m.maxBorrowableLimit.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('dashTotalDebt').textContent = `₹${m.totalDebt.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('dashPrincipalDebt').textContent = `₹${m.totalPrincipalDebt.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('dashInterestDebt').textContent = `₹${m.totalAccruedInterest.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

    // 2. Update LTV Health Gauge & Pointer
    updateLtvHealthGauge(m);

    // 3. Render Holdings Table
    if (renderHoldingsTable) {
      renderHoldingsView(state.portfolio.holdings);
    }

    // 4. Update Donut Chart
    renderCollateralDonut();

    // 5. Margin Call Urgent Warning Banner evaluation
    evaluateMarginCallBanner(m);

  } catch (err) {
    console.error('Error refreshing portfolio:', err);
  }
}

function updateLtvHealthGauge(m) {
  const ltv = m.currentLtv;
  const pointer = document.getElementById('meterPointer');
  const pointerLabel = document.getElementById('pointerLabel');
  const badge = document.getElementById('ltvHealthBadge');

  // Clamp pointer display between 2% and 98%
  const clampedPos = Math.min(98, Math.max(2, ltv));
  pointer.style.left = `${clampedPos}%`;
  pointerLabel.textContent = `${ltv.toFixed(1)}%`;

  document.getElementById('lblCurrentLtv').textContent = `${ltv.toFixed(2)}%`;
  document.getElementById('lblCurrentLtv').style.color = m.healthColor;
  document.getElementById('lblLtvStatus').textContent = m.healthStatus.replace('_', ' ');
  document.getElementById('lblLtvStatus').style.color = m.healthColor;
  document.getElementById('lblShortfall').textContent = `₹${m.shortfallAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  document.getElementById('lblCashBal').textContent = `₹${state.portfolio.cashBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  badge.textContent = m.healthStatus.replace('_', ' ');
  badge.style.backgroundColor = `${m.healthColor}20`;
  badge.style.color = m.healthColor;
}

function evaluateMarginCallBanner(m) {
  const banner = document.getElementById('marginCallBanner');
  if (m.currentLtv >= m.thresholds.marginCall && m.totalDebt > 0) {
    banner.classList.remove('hidden');
    document.getElementById('bannerTitle').textContent = `URGENT MARGIN CALL: Portfolio LTV is ${m.currentLtv.toFixed(1)}% (Limit: ${m.thresholds.marginCall}%)`;
    document.getElementById('bannerMsg').textContent = `Shortfall deficit of ₹${m.shortfallAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })} must be cured immediately to avoid automated liquidation of your pledged collateral.`;
  } else {
    banner.classList.add('hidden');
  }
}

// Holdings View Table Render
function renderHoldingsView(holdings) {
  const tbody = document.getElementById('holdingsTableBody');
  tbody.innerHTML = '';
  document.getElementById('holdingsCountBadge').textContent = `${holdings.length} Equities`;

  holdings.forEach(h => {
    const isPnlPos = h.unrealized_pnl >= 0;
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>
        <strong>${h.symbol}</strong>
        <div style="font-size:10px; color:var(--text-subtle);">${h.company_name}</div>
      </td>
      <td><strong>${h.total_quantity}</strong></td>
      <td>₹${h.average_buy_price.toFixed(2)}</td>
      <td><strong>₹${h.current_price.toFixed(2)}</strong></td>
      <td>₹${h.current_value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
      <td class="${isPnlPos ? 'text-green' : 'text-red'}">
        <strong>${isPnlPos ? '+' : ''}₹${h.unrealized_pnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
        <div style="font-size:10px;">(${isPnlPos ? '+' : ''}${h.unrealized_pnl_pct.toFixed(2)}%)</div>
      </td>
      <td>
        <span class="badge badge-neutral">${h.haircut_pct}%</span>
      </td>
      <td>
        <strong>${h.pledged_quantity}</strong>
        <span style="font-size:10px; color:var(--text-subtle);">(${h.free_quantity} free)</span>
      </td>
      <td class="text-blue">
        <strong>₹${h.pledged_net_collateral.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
      </td>
      <td>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-sm btn-primary" onclick="openPledgeModal('${h.symbol}', 'PLEDGE', ${h.free_quantity})">Pledge</button>
          ${h.pledged_quantity > 0 ? `<button class="btn btn-sm btn-secondary" onclick="openPledgeModal('${h.symbol}', 'UNPLEDGE', ${h.pledged_quantity})">Unpledge</button>` : ''}
          <button class="btn btn-sm btn-outline" onclick="openOrderModal('${h.symbol}', 'BUY')">Trade</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

function renderCollateralDonut() {
  const canvas = document.getElementById('collateralDonutChart');
  if (!canvas || !state.portfolio) return;

  const m = state.portfolio.metrics;
  const pledged = m.grossPledgedValue;
  const free = m.freeHoldingsValue;
  const debt = m.totalDebt;

  if (state.donutChart) {
    state.donutChart.destroy();
  }

  const isDark = document.body.classList.contains('theme-dark');
  const textColor = isDark ? '#94a3b8' : '#666666';

  state.donutChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Pledged Collateral', 'Free Holdings', 'Margin Debt'],
      datasets: [{
        data: [pledged, free, debt],
        backgroundColor: ['#387ed1', '#00d09c', '#f6465d'],
        borderWidth: 2,
        borderColor: isDark ? '#181b22' : '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: textColor, font: { size: 11, family: 'Inter' } }
        }
      },
      cutout: '70%'
    }
  });
}

// ============================================================================
// MARGIN LOANS (LAS / MTF) MANAGEMENT
// ============================================================================

async function loadLoans() {
  if (!state.token) return;

  try {
    const res = await fetch(`${API_BASE}/loans`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (!data.success) return;

    state.loans = data.loans;
    renderLoansTable(data.loans);
  } catch (err) {
    console.error('Error loading loans:', err);
  }
}

function renderLoansTable(loans) {
  const tbody = document.getElementById('loansTableBody');
  tbody.innerHTML = '';

  if (loans.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-subtle);">No margin loans active. Click "Borrow Instant Margin" to apply.</td></tr>';
    return;
  }

  loans.forEach(loan => {
    const tr = document.createElement('tr');
    const isRepaid = loan.status === 'REPAID';
    const isMarginCall = loan.status === 'MARGIN_CALL';

    let statusBadge = '<span class="badge" style="background:#00d09c20; color:#00d09c;">ACTIVE</span>';
    if (isRepaid) statusBadge = '<span class="badge" style="background:#99999920; color:#999999;">REPAID</span>';
    if (isMarginCall) statusBadge = '<span class="badge" style="background:#ff572220; color:#ff5722;">MARGIN CALL</span>';

    tr.innerHTML = `
      <td><strong>${loan.id}</strong></td>
      <td>${new Date(loan.disbursed_at).toLocaleDateString('en-IN')}</td>
      <td>₹${loan.principal_amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
      <td><strong class="text-red">₹${loan.current_principal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong></td>
      <td class="text-orange">₹${loan.accrued_interest.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
      <td>${loan.interest_rate_annual}% p.a.</td>
      <td>${loan.initial_ltv_pct.toFixed(1)}%</td>
      <td>${statusBadge}</td>
      <td>
        ${!isRepaid ? `<button class="btn btn-sm btn-primary" onclick="openRepayModalForLoan('${loan.id}')">Repay</button>` : `<span style="color:var(--text-subtle); font-size:11px;">Settled</span>`}
      </td>
    `;

    tbody.appendChild(tr);
  });
}

// ============================================================================
// IMMUTABLE FINANCIAL LEDGER & CRYPTOGRAPHIC AUDIT
// ============================================================================

async function loadLedger() {
  if (!state.token) return;

  try {
    const res = await fetch(`${API_BASE}/ledger?limit=100`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (!data.success) return;

    state.ledgerEntries = data.entries;
    renderLedgerTable(data.entries);
  } catch (err) {
    console.error('Error loading ledger:', err);
  }
}

function renderLedgerTable(entries) {
  const tbody = document.getElementById('ledgerTableBody');
  tbody.innerHTML = '';

  entries.forEach(e => {
    const tr = document.createElement('tr');
    const isDr = e.entry_type.includes('WITHDRAWAL') || e.entry_type.includes('DISBURSEMENT');

    tr.innerHTML = `
      <td>#${e.sequence_num}</td>
      <td>${new Date(e.created_at).toLocaleTimeString('en-IN')}</td>
      <td><strong style="color:var(--kite-blue);">${e.entry_type}</strong></td>
      <td>${e.reference_id || '-'}</td>
      <td style="max-width:240px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${e.description}</td>
      <td class="${isDr ? 'text-blue' : ''}">${isDr ? `₹${e.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '-'}</td>
      <td class="${!isDr ? 'text-green' : ''}">${!isDr ? `₹${e.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '-'}</td>
      <td><strong>₹${e.user_cash_balance_after.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong></td>
      <td class="text-red">₹${e.user_total_debt_after.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
      <td>
        <span class="hash-badge" title="Chained SHA-256 Hash: ${e.audit_hash}" onclick="navigator.clipboard.writeText('${e.audit_hash}'); showToast('Hash copied to clipboard!', 'info')">
          ${e.audit_hash.substring(0, 10)}...
        </span>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

async function verifyLedgerAudit() {
  try {
    const res = await fetch(`${API_BASE}/ledger/verify`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (data.success && data.auditReport.isValid) {
      document.getElementById('auditChainStatusText').textContent = `Cryptographic Chain: VERIFIED & INTACT (${data.auditReport.totalEntries} Blocks Audited)`;
      document.getElementById('auditChainSubText').textContent = `Last Block Checksum: ${data.auditReport.lastAuditHash}. Cryptographically tamper-proof.`;
      showToast(`Ledger mathematically verified! ${data.auditReport.totalEntries} entries audited with zero discrepancies.`, 'success');
    } else {
      showToast('Chain integrity issue detected!', 'error');
    }
  } catch (err) {
    showToast('Failed to verify ledger checksum.', 'error');
  }
}

// ============================================================================
// MARKET SHOCK SIMULATOR & MARGIN STRESS TESTING
// ============================================================================

function initShockSimulator() {
  const slider = document.getElementById('shockSlider');
  const display = document.getElementById('shockDisplayVal');

  slider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    display.textContent = `${val > 0 ? '+' : ''}${val}%`;
    display.style.color = val < 0 ? 'var(--red)' : (val > 0 ? 'var(--green)' : 'var(--text-main)');
  });

  document.getElementById('applyShockBtn').addEventListener('click', () => {
    const shockPct = parseFloat(slider.value);
    applyMarketShock(shockPct);
  });

  document.getElementById('quickCrash35Btn').addEventListener('click', () => {
    slider.value = -35;
    display.textContent = '-35%';
    display.style.color = 'var(--red)';
    applyMarketShock(-35);
  });

  document.getElementById('resetMarketBtn').addEventListener('click', async () => {
    slider.value = 0;
    display.textContent = '0%';
    display.style.color = 'var(--text-main)';
    
    const res = await fetch(`${API_BASE}/margin/reset-market`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast('Market prices reset to baseline.', 'success');
      await refreshPortfolio();
      await loadMarketInstruments();
    }
  });

  document.getElementById('simAutoLiquidateBtn').addEventListener('click', triggerAutoLiquidation);
  document.getElementById('autoLiquidateBtn').addEventListener('click', triggerAutoLiquidation);
}

async function applyMarketShock(shockPct) {
  try {
    const res = await fetch(`${API_BASE}/margin/simulate-shock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ shockPct })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Market shock of ${shockPct}% applied! Collateral recalculated.`, shockPct < 0 ? 'error' : 'success');
      await refreshPortfolio();
      await loadMarketInstruments();

      const m = data.portfolio.metrics;
      document.getElementById('simCurrentLtv').textContent = `${m.currentLtv.toFixed(2)}%`;
      document.getElementById('simCurrentLtv').style.color = m.healthColor;
      document.getElementById('simTriggerStatus').textContent = m.healthStatus.replace('_', ' ');
      document.getElementById('simTriggerStatus').style.color = m.healthColor;
      document.getElementById('simShortfallAmt').textContent = `₹${m.shortfallAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
      document.getElementById('simLiquidationStatus').textContent = m.currentLtv >= m.thresholds.liquidation ? 'ACTION REQUIRED' : 'Normal';
    }
  } catch (err) {
    showToast('Failed to apply shock.', 'error');
  }
}

async function triggerAutoLiquidation() {
  try {
    const res = await fetch(`${API_BASE}/margin/liquidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      }
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Automated Liquidation Executed: Sold ${data.liquidation.sharesSold} shares of ${data.liquidation.liquidatedSymbol} for ₹${data.liquidation.grossProceeds.toFixed(2)}. Debt settled!`, 'success');
      await refreshPortfolio();
      await loadLoans();
      await loadLedger();
    } else {
      showToast(data.message || 'Liquidation failed.', 'error');
    }
  } catch (err) {
    showToast('Liquidation error: ' + err.message, 'error');
  }
}

// ============================================================================
// MODALS LOGIC
// ============================================================================

function initModals() {
  // Modal Close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      document.getElementById(modalId).classList.add('hidden');
    });
  });

  // Apply Loan Modal Trigger
  document.getElementById('openApplyLoanModalBtn').addEventListener('click', openApplyLoanModal);
  document.getElementById('quickApplyLoanBtn').addEventListener('click', openApplyLoanModal);
  document.getElementById('loansTabApplyBtn').addEventListener('click', openApplyLoanModal);

  // Apply Loan Chips
  document.querySelectorAll('#applyLoanModal .chip[data-amt]').forEach(c => {
    c.addEventListener('click', () => {
      document.getElementById('loanAmountInput').value = c.getAttribute('data-amt');
    });
  });

  document.getElementById('chipMaxAmt').addEventListener('click', () => {
    if (state.portfolio) {
      const maxAvailable = Math.floor(state.portfolio.metrics.availableMarginToBorrow);
      document.getElementById('loanAmountInput').value = maxAvailable;
    }
  });

  document.getElementById('submitApplyLoanBtn').addEventListener('click', submitApplyLoan);

  // Repay Modal Trigger
  document.getElementById('openRepayModalBtn').addEventListener('click', () => {
    const activeLoan = state.loans.find(l => l.status === 'ACTIVE' || l.status === 'MARGIN_CALL');
    if (!activeLoan) {
      showToast('No active margin loan to repay.', 'info');
      return;
    }
    openRepayModalForLoan(activeLoan.id);
  });

  document.getElementById('cureRepayBtn').addEventListener('click', () => {
    const activeLoan = state.loans.find(l => l.status === 'MARGIN_CALL' || l.status === 'ACTIVE');
    if (activeLoan) openRepayModalForLoan(activeLoan.id);
  });

  // Repay Chips
  document.querySelectorAll('#repayLoanModal .chip[data-amt]').forEach(c => {
    c.addEventListener('click', () => {
      document.getElementById('repayAmountInput').value = c.getAttribute('data-amt');
    });
  });

  document.getElementById('repayInterestOnlyChip').addEventListener('click', () => {
    if (state.activeRepayLoan) {
      document.getElementById('repayAmountInput').value = Math.ceil(state.activeRepayLoan.accrued_interest);
    }
  });

  document.getElementById('repayFullPayoffChip').addEventListener('click', () => {
    if (state.activeRepayLoan) {
      document.getElementById('repayAmountInput').value = Math.ceil(state.activeRepayLoan.current_principal + state.activeRepayLoan.accrued_interest);
    }
  });

  document.getElementById('submitRepayLoanBtn').addEventListener('click', submitRepayLoan);

  // Pledge Modals
  document.getElementById('openPledgeModalBtn').addEventListener('click', () => {
    const holding = state.portfolio?.holdings[0];
    if (holding) openPledgeModal(holding.symbol, 'PLEDGE', holding.free_quantity);
  });

  document.getElementById('curePledgeBtn').addEventListener('click', () => {
    const freeHolding = state.portfolio?.holdings.find(h => h.free_quantity > 0);
    if (freeHolding) {
      openPledgeModal(freeHolding.symbol, 'PLEDGE', freeHolding.free_quantity);
    } else {
      showToast('All demat holdings are already pledged.', 'info');
    }
  });

  document.getElementById('submitPledgeBtn').addEventListener('click', submitPledge);

  // Order Execution (Buy/Sell) Modal
  document.getElementById('btnSideBuy').addEventListener('click', () => setOrderSide('BUY'));
  document.getElementById('btnSideSell').addEventListener('click', () => setOrderSide('SELL'));
  document.getElementById('orderQtyInput').addEventListener('input', updateOrderCalculation);
  document.getElementById('submitOrderBtn').addEventListener('click', submitOrder);

  // Verify Checksum Chain Button
  document.getElementById('verifyAuditChainBtn').addEventListener('click', verifyLedgerAudit);
  document.getElementById('quickVerifyLedgerBtn').addEventListener('click', () => {
    const navBtn = document.querySelector('.nav-btn[data-tab="ledger"]');
    if (navBtn) navBtn.click();
    verifyLedgerAudit();
  });

  // Export CSV
  document.getElementById('exportCsvBtn').addEventListener('click', exportLedgerCsv);
}

function openApplyLoanModal() {
  if (!state.portfolio) return;
  const m = state.portfolio.metrics;
  document.getElementById('modalCollateralVal').textContent = `₹${m.eligibleCollateralValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  document.getElementById('modalMaxBorrow').textContent = `₹${m.maxBorrowableLimit.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  document.getElementById('modalAvailableBorrow').textContent = `₹${m.availableMarginToBorrow.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  document.getElementById('loanAmountInput').value = Math.min(50000, Math.floor(m.availableMarginToBorrow));
  document.getElementById('applyLoanModal').classList.remove('hidden');
}

async function submitApplyLoan() {
  const amt = parseFloat(document.getElementById('loanAmountInput').value);
  if (isNaN(amt) || amt < 5000) {
    showToast('Minimum loan amount is ₹5,000.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/loans/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ amount: amt })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      document.getElementById('applyLoanModal').classList.add('hidden');
      await refreshPortfolio();
      await loadLoans();
      await loadLedger();
    } else {
      showToast(data.message || 'Loan application failed.', 'error');
    }
  } catch (err) {
    showToast('Network error during loan application.', 'error');
  }
}

function openRepayModalForLoan(loanId) {
  const loan = state.loans.find(l => l.id === loanId);
  if (!loan) return;

  state.activeRepayLoan = loan;
  document.getElementById('repayModalLoanId').textContent = loan.id;
  document.getElementById('repayModalPrincipal').textContent = `₹${loan.current_principal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  document.getElementById('repayModalInterest').textContent = `₹${loan.accrued_interest.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const total = loan.current_principal + loan.accrued_interest;
  document.getElementById('repayModalTotal').textContent = `₹${total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  document.getElementById('repayAvailableCash').textContent = `₹${state.portfolio?.cashBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || '0'}`;
  document.getElementById('repayAmountInput').value = Math.ceil(total);

  document.getElementById('repayLoanModal').classList.remove('hidden');
}

async function submitRepayLoan() {
  if (!state.activeRepayLoan) return;

  const amt = parseFloat(document.getElementById('repayAmountInput').value);
  const source = document.querySelector('input[name="repaySource"]:checked').value;

  if (isNaN(amt) || amt <= 0) {
    showToast('Enter a valid repayment amount.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/loans/${state.activeRepayLoan.id}/repay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ amount: amt, source })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      document.getElementById('repayLoanModal').classList.add('hidden');
      await refreshPortfolio();
      await loadLoans();
      await loadLedger();
    } else {
      showToast(data.message || 'Repayment failed.', 'error');
    }
  } catch (err) {
    showToast('Network error during repayment.', 'error');
  }
}

window.openPledgeModal = function(symbol, action, maxQty) {
  const holding = state.portfolio?.holdings.find(h => h.symbol === symbol);
  if (!holding) return;

  state.activePledgeHolding = { symbol, action, maxQty, holding };
  document.getElementById('pledgeModalTitle').textContent = action === 'PLEDGE' ? `Pledge ${symbol} as Collateral` : `Unpledge ${symbol}`;
  document.getElementById('pledgeSymbol').textContent = symbol;
  document.getElementById('pledgeCmp').textContent = `₹${holding.current_price.toFixed(2)}`;
  document.getElementById('pledgeHaircut').textContent = `${holding.haircut_pct}%`;
  document.getElementById('pledgeAvailableQtyLabel').textContent = action === 'PLEDGE' ? 'Free Quantity Available:' : 'Pledged Quantity:';
  document.getElementById('pledgeMaxQty').textContent = `${maxQty} shares`;
  document.getElementById('pledgeQtyInput').value = maxQty;
  document.getElementById('pledgeQtyInput').max = maxQty;

  const estVal = maxQty * holding.current_price * (1.0 - (holding.haircut_pct / 100.0));
  document.getElementById('pledgeNetValEst').textContent = `₹${estVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  document.getElementById('pledgeModal').classList.remove('hidden');
};

window.openPledgeModalForSymbol = function(symbol) {
  const holding = state.portfolio?.holdings.find(h => h.symbol === symbol);
  if (holding) {
    openPledgeModal(symbol, 'PLEDGE', holding.free_quantity);
  } else {
    showToast(`You do not own shares of ${symbol} yet. Buy shares first to pledge.`, 'info');
  }
};

async function submitPledge() {
  if (!state.activePledgeHolding) return;
  const { symbol, action } = state.activePledgeHolding;
  const qty = parseInt(document.getElementById('pledgeQtyInput').value, 10);

  if (isNaN(qty) || qty <= 0) {
    showToast('Enter a valid share quantity.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/portfolio/pledge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ symbol, quantity: qty, action })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      document.getElementById('pledgeModal').classList.add('hidden');
      await refreshPortfolio();
      await loadLedger();
    } else {
      showToast(data.message || 'Pledge operation failed.', 'error');
    }
  } catch (err) {
    showToast('Network error during pledge.', 'error');
  }
}

// Order Execution (Buy/Sell)
window.openOrderModal = function(symbol, side = 'BUY') {
  const inst = state.instruments.find(i => i.symbol === symbol);
  if (!inst) return;

  state.activeOrderInstrument = inst;
  document.getElementById('orderSymbol').textContent = `${inst.symbol} (${inst.exchange})`;
  document.getElementById('orderCmp').textContent = `₹${inst.current_price.toFixed(2)}`;
  document.getElementById('orderCashBal').textContent = `₹${state.portfolio?.cashBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || '0'}`;
  document.getElementById('orderQtyInput').value = 10;

  setOrderSide(side);
  updateOrderCalculation();
  document.getElementById('orderModal').classList.remove('hidden');
};

function setOrderSide(side) {
  state.orderSide = side;
  const btnBuy = document.getElementById('btnSideBuy');
  const btnSell = document.getElementById('btnSideSell');
  const submitBtn = document.getElementById('submitOrderBtn');

  if (side === 'BUY') {
    btnBuy.classList.add('active');
    btnSell.classList.remove('active');
    submitBtn.textContent = 'Execute Buy Order';
    submitBtn.style.backgroundColor = 'var(--kite-blue)';
  } else {
    btnBuy.classList.remove('active');
    btnSell.classList.add('active');
    submitBtn.textContent = 'Execute Sell Order';
    submitBtn.style.backgroundColor = 'var(--kite-orange)';
  }
  updateOrderCalculation();
}

function updateOrderCalculation() {
  if (!state.activeOrderInstrument) return;
  const qty = parseInt(document.getElementById('orderQtyInput').value, 10) || 0;
  const total = qty * state.activeOrderInstrument.current_price;
  document.getElementById('orderTotalVal').textContent = `₹${total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

async function submitOrder() {
  if (!state.activeOrderInstrument) return;
  const qty = parseInt(document.getElementById('orderQtyInput').value, 10);

  if (isNaN(qty) || qty <= 0) {
    showToast('Enter a valid quantity.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/portfolio/order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({
        symbol: state.activeOrderInstrument.symbol,
        quantity: qty,
        side: state.orderSide
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      document.getElementById('orderModal').classList.add('hidden');
      await refreshPortfolio();
      await loadLedger();
    } else {
      showToast(data.message || 'Order failed.', 'error');
    }
  } catch (err) {
    showToast('Network error during order execution.', 'error');
  }
}

// Export CSV Statement
function exportLedgerCsv() {
  if (!state.ledgerEntries || state.ledgerEntries.length === 0) {
    showToast('No ledger entries to export.', 'info');
    return;
  }

  const headers = ['Sequence', 'Timestamp', 'Type', 'Debit Account', 'Credit Account', 'Amount', 'Cash After', 'Debt After', 'Description', 'Reference', 'Audit Hash'];
  const rows = state.ledgerEntries.map(e => [
    e.sequence_num,
    e.created_at,
    e.entry_type,
    e.account_debited,
    e.account_credited,
    e.amount,
    e.user_cash_balance_after,
    e.user_total_debt_after,
    `"${(e.description || '').replace(/"/g, '""')}"`,
    e.reference_id || '',
    e.audit_hash
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `Finodha_Ledger_Statement_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Ledger statement downloaded as CSV.', 'success');
}

// Toast Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3800);
}
