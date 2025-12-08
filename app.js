(function(){
  "use strict";

  /**
   * Default tax brackets aligned with Stage 3 (effective 1 Jul 2024).
   * Array of { threshold, rate } where threshold is inclusive lower bound.
   * Rates are decimals (e.g., 0.16 for 16%).
   * Example piecewise: 0% up to 18,200; 16% >18,200; 30% >45,000; 37% >135,000; 45% >190,000
   */
  const defaultTaxBrackets = [
    { threshold: 0, rate: 0.00 },
    { threshold: 18200, rate: 0.16 },
    { threshold: 45000, rate: 0.30 },
    { threshold: 135000, rate: 0.37 },
    { threshold: 190000, rate: 0.45 },
  ];

  // Medicare levy simple flat rate (user can override). 2% default.
  let medicareRate = 0.02;

  // LMI tiers default: simple approximation
  // If LVR <= 80% -> 0; 80-85: 0.5%; 85-90: 1.0%; 90-95: 2.0%; >95: 3.5%
  const defaultLmiTiers = [
    { min: 0, max: 80, pct: 0 },
    { min: 80, max: 85, pct: 0.005 },
    { min: 85, max: 90, pct: 0.01 },
    { min: 90, max: 95, pct: 0.02 },
    { min: 95, max: 100, pct: 0.035 },
  ];

  // Australian cities house price appreciation data (annual rates)
  const cityAppreciationRates = {
    sydney: 6.9,
    melbourne: 4.6,
    brisbane: 6.5,
    perth: 3.1,
    adelaide: 6.7,
    hobart: 7.0,
    canberra: 5.9,
    darwin: 0.5
  };

  function currency(n){
    if (!isFinite(n)) return "—";
    return n.toLocaleString(undefined, { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
  }
  function currency2(n){
    if (!isFinite(n)) return "—";
    return n.toLocaleString(undefined, { style: "currency", currency: "AUD", maximumFractionDigits: 2 });
  }
  function percent(n){
    if (!isFinite(n)) return "—";
    return (n*100).toFixed(2) + "%";
  }

  function readNumber(id){
    const el = document.getElementById(id);
    if (!el) return 0;
    const v = parseFloat(el.value);
    return isNaN(v) ? 0 : v;
  }

  function handleCitySelection(){
    const citySelect = document.getElementById('investmentCity');
    const appreciationInput = document.getElementById('appreciationPct');
    
    if (!citySelect || !appreciationInput) return;
    
    const selectedCity = citySelect.value;
    
    if (selectedCity === 'custom') {
      // Allow manual entry - don't change the current value
      return;
    }
    
    const appreciationRate = cityAppreciationRates[selectedCity];
    if (appreciationRate !== undefined) {
      appreciationInput.value = appreciationRate.toFixed(1);
      recalc(); // Trigger recalculation with new appreciation rate
    }
  }

  function buildTaxBracketsFromTable(){
    const rows = document.querySelectorAll('#taxBracketsTable tbody tr');
    const brackets = [];
    rows.forEach(r => {
      const threshold = parseFloat(r.querySelector('.tb-threshold').value) || 0;
      const rate = (parseFloat(r.querySelector('.tb-rate').value) || 0) / 100;
      brackets.push({ threshold, rate });
    });
    // sort by threshold ascending
    brackets.sort((a,b)=>a.threshold-b.threshold);
    return brackets;
  }

  function buildLmiTiersFromTable(){
    const rows = document.querySelectorAll('#lmiTable tbody tr');
    const tiers = [];
    rows.forEach(r => {
      const min = parseFloat(r.querySelector('.lmi-min').value) || 0;
      const max = parseFloat(r.querySelector('.lmi-max').value) || 0;
      const pct = (parseFloat(r.querySelector('.lmi-pct').value) || 0) / 100;
      tiers.push({ min, max, pct });
    });
    tiers.sort((a,b)=>a.min-b.min);
    return tiers;
  }

  function incomeTaxAnnual(taxableIncome, brackets){
    // Piecewise progressive tax without offsets; add Medicare separately
    if (taxableIncome <= 0) return 0;
    let tax = 0;
    for (let i = 0; i < brackets.length; i++) {
      const curr = brackets[i];
      const next = brackets[i+1];
      const lower = curr.threshold;
      const upper = next ? next.threshold : Infinity;
      if (taxableIncome > lower) {
        const amountInBand = Math.min(taxableIncome, upper) - lower;
        tax += amountInBand * curr.rate;
      }
    }
    return tax;
  }

  function marginalRateForIncome(taxableIncome, brackets){
    // Returns top bracket rate (excluding medicare)
    let rate = 0;
    for (let i = 0; i < brackets.length; i++) {
      const next = brackets[i+1];
      if (!next || taxableIncome < next.threshold) {
        rate = brackets[i].rate;
        break;
      }
    }
    return rate;
  }

  function annuityMonthlyPayment(principal, annualRate, years){
    // Standard mortgage payment formula for P&I
    if (principal <= 0) return 0;
    const r = (annualRate/100) / 12;
    const n = years * 12;
    if (r === 0) return principal / n;
    const pmt = principal * r / (1 - Math.pow(1 + r, -n));
    return pmt;
  }

  function estimateYearOneInterestPI(principal, annualRate, years){
    // Approximate year 1 interest portion for P&I loan
    const monthly = annuityMonthlyPayment(principal, annualRate, years);
    const r = (annualRate/100) / 12;
    let balance = principal;
    let interestPaid = 0;
    for (let m=0; m<12; m++){
      const interest = balance * r;
      const principalPaid = Math.max(0, monthly - interest);
      balance = Math.max(0, balance - principalPaid);
      interestPaid += interest;
    }
    const principalPaidYear = Math.max(0, principal - balance);
    return { interestPaid, principalPaidYear };
  }

  function estimateLmiCost(lvrPct, loanAmount, tiers){
    if (lvrPct <= 80) return 0;
    const t = tiers.find(x => lvrPct > x.min && lvrPct <= x.max) || tiers[tiers.length-1];
    return loanAmount * t.pct;
  }

  function recalc(){
    const salarySelf = readNumber('salarySelf');
    const salarySpouse = readNumber('salarySpouse');
    const purchasePrice = readNumber('purchasePrice');
    const deposit = readNumber('deposit');
    const weeklyRent = readNumber('weeklyRent');
    const interestRate = readNumber('interestRate');
    const termYears = readNumber('loanTermYears');
    const loanType = (document.getElementById('loanType') || {}).value || 'P&I';
    const ownershipSelf = Math.min(100, Math.max(0, readNumber('ownershipSelfPct'))) / 100;
    const ownershipSpouse = 1 - ownershipSelf;

    // Upfront costs: set to 5% of purchase price (auto-calculated)
    const upfrontCosts = purchasePrice * 0.05;
    const upfrontEl = document.getElementById('upfrontCosts');
    if (upfrontEl && isFinite(upfrontCosts)) {
      // Keep the UI in sync so users see the 5% figure reflected
      upfrontEl.value = Math.round(upfrontCosts);
    }
    const councilRates = readNumber('councilRates');
    const waterRates = readNumber('waterRates');
    const landlordInsurance = readNumber('landlordInsurance');
    const maintenancePct = readNumber('maintenancePct')/100;
    const pmFeePct = readNumber('pmFeePct')/100;
    const depreciation = readNumber('depreciation');
    const agentPurchasePct = readNumber('agentPurchasePct')/100;
    const agentSellingPct = readNumber('agentSellingPct')/100;
    const marketingCosts = readNumber('marketingCosts');

    // Tax config from UI
    const brackets = buildTaxBracketsFromTable();
    medicareRate = (parseFloat(document.getElementById('medicareRatePct').value) || 0)/100;
    const lmiTiers = buildLmiTiersFromTable();

    // New projection controls
    const investDelayYears = Math.max(0, Math.floor(readNumber('investDelayYears')));
    const pporExtraMonthly = Math.max(0, readNumber('pporExtraMonthly'));

    const annualRent = weeklyRent * 52;
    const managementFee = annualRent * pmFeePct;
    const maintenance = purchasePrice * maintenancePct;
    const agentPurchaseCost = purchasePrice * agentPurchasePct;
    const agentSellingCost = purchasePrice * agentSellingPct;
    const totalSellingCosts = agentSellingCost + marketingCosts;
    const itemisedExpenses = councilRates + waterRates + landlordInsurance + managementFee + maintenance;

    // Base loan before LMI
    const baseLoan = Math.max(0, purchasePrice - deposit);
    const baseLvr = purchasePrice > 0 ? (baseLoan / purchasePrice) * 100 : 0;
    const lmiCost = estimateLmiCost(baseLvr, baseLoan, lmiTiers);

    // Assume LMI is capitalised into the loan
    const loanAmount = baseLoan + lmiCost;
    const lvr = purchasePrice > 0 ? (loanAmount / purchasePrice) * 100 : 0;

    let annualInterest = 0;
    let annualPrincipal = 0;
    if (loanType === 'IO'){
      annualInterest = loanAmount * (interestRate/100);
      annualPrincipal = 0;
    } else {
      const { interestPaid, principalPaidYear } = estimateYearOneInterestPI(loanAmount, interestRate, termYears);
      annualInterest = interestPaid;
      annualPrincipal = principalPaidYear;
    }

    const totalAnnualExpenses = itemisedExpenses + annualInterest; // principal excluded for tax, but used for cashflow later
    const preDepResult = annualRent - itemisedExpenses - annualInterest; // gearing before depreciation
    const taxableLoss = preDepResult - depreciation; // can be negative or positive

    // Combined incomes and marginal rate approx (top bracket of combined taxable income)
    // Compute person-level marginal rates and savings
    const mtrSelf = marginalRateForIncome(salarySelf, brackets) + medicareRate;
    const mtrSpouse = marginalRateForIncome(salarySpouse, brackets) + medicareRate;
    const lossSelf = Math.min(0, taxableLoss * ownershipSelf);
    const lossSpouse = Math.min(0, taxableLoss * ownershipSpouse);
    const taxSavingsSelf = -lossSelf * mtrSelf;
    const taxSavingsSpouse = -lossSpouse * mtrSpouse;
    const annualTaxSavings = taxSavingsSelf + taxSavingsSpouse;
    const combinedMtr = (taxableLoss < 0) ? (annualTaxSavings / (-taxableLoss)) : (mtrSelf*ownershipSelf + mtrSpouse*ownershipSpouse);

    // Out of pocket before tax: include principal for cashflow burden
    const oopBeforeTax = (itemisedExpenses + annualInterest + annualPrincipal) - annualRent;
    const oopAfterTax = oopBeforeTax - annualTaxSavings;

    // Derived
    const rentalYield = purchasePrice > 0 ? annualRent / purchasePrice : 0;
    
    // UI updates
    document.getElementById('annualRent').textContent = currency(annualRent);
    document.getElementById('annualExpenses').textContent = currency(itemisedExpenses);
    document.getElementById('totalAnnualExpenses').textContent = currency(itemisedExpenses + annualInterest);
    document.getElementById('annualInterest').textContent = currency(annualInterest);
    document.getElementById('annualPrincipal').textContent = currency(annualPrincipal);
    document.getElementById('rentalYield').textContent = percent(rentalYield);
    document.getElementById('loanAmount').textContent = currency(loanAmount);
    document.getElementById('lvr').textContent = (isFinite(lvr) ? lvr.toFixed(2) + '%' : '—');
    document.getElementById('lmiCost').textContent = currency(lmiCost);
    document.getElementById('netGearingPreDep').textContent = currency(preDepResult);
    document.getElementById('taxableLoss').textContent = currency(taxableLoss);
    document.getElementById('annualTaxSavings').textContent = currency(annualTaxSavings);
    document.getElementById('oopBeforeTax').textContent = currency(oopBeforeTax);
    document.getElementById('oopAfterTax').textContent = currency(oopAfterTax);
    document.getElementById('monthlyOop').textContent = `${currency2(oopBeforeTax/12)} / ${currency2(oopAfterTax/12)}`;
    document.getElementById('combinedMtr').textContent = isFinite(mtrSelf+mtrSpouse) ? `${(mtrSelf*100).toFixed(2)}% / ${(mtrSpouse*100).toFixed(2)}%` : '—';
    document.getElementById('effectiveMtr').textContent = isFinite(combinedMtr) ? (combinedMtr*100).toFixed(2) + '%' : '—';

    // Projections
    runProjections({
      salarySelf, salarySpouse, ownershipSelf, ownershipSpouse,
      purchasePrice, deposit, upfrontCosts, interestRate, termYears, loanType,
      annualRent, itemisedExpenses, depreciation, lmiCost, loanAmount,
      agentPurchaseCost, totalSellingCosts,
      medicareRate, brackets,
      investDelayYears, pporExtraMonthly
    });
  }

  function runProjections(ctx){
    const appreciationPct = Math.max(-1, readNumber('appreciationPct')/100);
    const horizonYears = Math.max(1, Math.floor(readNumber('horizonYears')));
    const altReturn = Math.max(0, readNumber('altReturnPct')/100);
    const pporValueStart = Math.max(0, readNumber('pporValue'));
    const pporBalanceStart = Math.max(0, readNumber('pporBalance'));
    const pporRate = Math.max(0, readNumber('pporRate'));
    const pporTermYears = Math.max(1, Math.floor(readNumber('pporTermYears')));
    
    // PPOR appreciation rate (user can override, defaults to Sydney rate)
    const pporAppreciationPct = Math.max(-1, readNumber('pporAppreciationPct')/100);
    
    // No explicit monthly surplus. We'll derive extra PPOR repayments for the No-Invest scenario from the IP monthly OOP before tax.

    // Setup investment loan, but allow delaying start until investDelayYears
    let balance = 0;
    let monthlyRate = (ctx.interestRate/100)/12;
    let monthlyPmt = 0;

    let propertyValue = ctx.purchasePrice;
    // Baseline: apply lump-sum to PPOR immediately; only the deposit is redirected in No-Invest
    const lumpSum = Math.max(0, (ctx.deposit||0));
    let pporBalanceNoInvest = Math.max(0, pporBalanceStart - lumpSum);
    const pporMonthlyRate = (pporRate/100)/12;
    const pporMonthlyPmt = annuityMonthlyPayment(pporBalanceNoInvest, pporRate, pporTermYears);

    // Invest path: assume no lump sum to PPOR at start; surplus equals the investment after-tax out-of-pocket (user requested same surplus as extra amount for IP)
    let pporBalanceInvest = pporBalanceStart;
    const pporMonthlyPmtInvest = annuityMonthlyPayment(pporBalanceInvest, pporRate, pporTermYears);

    const years = [];
    let cumulativeAfterTax = 0;

    let pporValueInvest = pporValueStart;
    let pporValueNoInvest = pporValueStart;
    for (let y=1; y<=horizonYears; y++){
      // Annual loop (approximate by 12 monthly steps)
      let interestYear = 0;
      let principalYear = 0;
      for (let m=0; m<12; m++){
        // Activate investment from the month we cross investDelayYears
        if (balance <= 0 && y > ctx.investDelayYears) {
          balance = ctx.loanAmount;
          monthlyRate = (ctx.interestRate/100)/12;
          monthlyPmt = (ctx.loanType === 'IO') ? balance * monthlyRate : annuityMonthlyPayment(balance, ctx.interestRate, ctx.termYears);
        }
        const investmentActive = balance > 0;
        const interest = balance * monthlyRate;
        const principal = Math.max(0, monthlyPmt - interest);
        interestYear += interest;
        principalYear += (ctx.loanType === 'IO') ? 0 : principal;
        balance = Math.max(0, balance - principal);
        // Defer PPOR (No Invest) amortization to after we compute monthly extra from IP OOP
      }
      // Update values (investment property uses selected city rate, PPOR uses Sydney rate)
      propertyValue = propertyValue * (1 + appreciationPct);
      pporValueInvest = pporValueInvest * (1 + pporAppreciationPct);
      pporValueNoInvest = pporValueNoInvest * (1 + pporAppreciationPct);

      // Annual rent growth not modeled (keep constant); expenses constant
      const rentThisYear = (y > ctx.investDelayYears) ? ctx.annualRent : 0;
      const expensesThisYear = (y > ctx.investDelayYears) ? ctx.itemisedExpenses : 0;
      const depreciationThisYear = (y > ctx.investDelayYears) ? ctx.depreciation : 0;
      const preDep = rentThisYear - expensesThisYear - interestYear;
      const taxable = preDep - depreciationThisYear;

      // Person-level savings each year using constant individual MTRs
      const mtrSelf = marginalRateForIncome(ctx.salarySelf, ctx.brackets) + ctx.medicareRate;
      const mtrSpouse = marginalRateForIncome(ctx.salarySpouse, ctx.brackets) + ctx.medicareRate;
      const taxSavings = (taxable < 0) ? (-(taxable*ctx.ownershipSelf) * mtrSelf + -(taxable*ctx.ownershipSpouse) * mtrSpouse) : 0;
      const afterTaxCashflow = (rentThisYear - expensesThisYear - interestYear - principalYear) + taxSavings;
      const beforeTaxOOPAnnual = (expensesThisYear + interestYear + principalYear) - rentThisYear;
      const beforeTaxOOPMonthly = Math.max(0, beforeTaxOOPAnnual / 12);
      cumulativeAfterTax += afterTaxCashflow;

      // Equity = value - balance
      const equity = Math.max(0, propertyValue - balance);

      // Invest PPOR: scheduled repayments plus user extra
      const monthlyAdj = Math.max(0, ctx.pporExtraMonthly || 0);
      for (let m=0; m<12; m++){
        if (pporBalanceInvest <= 1e-6) break;
        const interestI = pporBalanceInvest * pporMonthlyRate;
        let principalI = Math.max(0, pporMonthlyPmtInvest - interestI);
        let extraI = monthlyAdj;
        const totalPrincipalI = Math.min(pporBalanceInvest, principalI + extraI);
        pporBalanceInvest = Math.max(0, pporBalanceInvest - totalPrincipalI);
      }

      // Now apply No-Invest: scheduled + user extra + (if investment active) extra equal to IP monthly OOP before tax
      for (let m=0; m<12; m++){
        if (pporBalanceNoInvest <= 1e-6) break;
        const interestNI2 = pporBalanceNoInvest * pporMonthlyRate;
        let principalNI2 = Math.max(0, pporMonthlyPmt - interestNI2);
        let extraNI2 = Math.max(0, ctx.pporExtraMonthly || 0) + ((y > ctx.investDelayYears) ? beforeTaxOOPMonthly : 0);
        const totalPrincipalNI2 = Math.min(pporBalanceNoInvest, principalNI2 + extraNI2);
        pporBalanceNoInvest = Math.max(0, pporBalanceNoInvest - totalPrincipalNI2);
      }

      // Net worths include PPOR equity (value - debt) and investment equity; we ignore liquid cash aside from cumulative savings if positive in invest path
      // For investment property, subtract selling costs from the final value
      const investmentEquity = Math.max(0, propertyValue - balance);
      const finalInvestmentValue = (y === horizonYears) ? Math.max(0, propertyValue - ctx.totalSellingCosts) : propertyValue;
      const finalInvestmentEquity = (y === horizonYears) ? Math.max(0, finalInvestmentValue - balance) : investmentEquity;
      
      const investNetWorth = finalInvestmentEquity + Math.max(0, pporValueInvest - pporBalanceInvest) + Math.max(0, cumulativeAfterTax);
      const noInvestNetWorth = Math.max(0, pporValueNoInvest - pporBalanceNoInvest);

      years.push({ y, balance, propertyValue, equity, interestYear, principalYear, afterTaxCashflow, cumulativeAfterTax, investNetWorth, noInvestNetWorth, pporBalanceInvest, pporBalanceNoInvest, pporValueInvest, pporValueNoInvest });
    }

    // Final net worth diff
    const last = years[years.length-1];
    const investNetWorth = last.investNetWorth;
    const baselineNetWorth = last.noInvestNetWorth;
    const finalDiff = investNetWorth - baselineNetWorth;

    document.getElementById('finalNetWorth').textContent = `${currency(investNetWorth)} (Δ ${currency(finalDiff)})`;

    drawChart(document.getElementById('cashflowChart'), years.map(p=>({x:p.y, y:p.afterTaxCashflow})), { zeroLine: true, color: '#18a34a' });
    drawMultiChart(document.getElementById('networthChart'), [
      { name:'Invest', points: years.map(p=>({x:p.y, y:p.investNetWorth})), color:'#2f71ff' },
      { name:'No Invest', points: years.map(p=>({x:p.y, y:p.noInvestNetWorth})), color:'#9aa4b2' }
    ], { zeroLine: false });

    // Render tables: Invest and No Invest side-by-side
    const tbodyInvest = document.querySelector('#networthTableInvest tbody');
    const tbodyNoInvest = document.querySelector('#networthTableNoInvest tbody');
    if (tbodyInvest) tbodyInvest.innerHTML = '';
    if (tbodyNoInvest) tbodyNoInvest.innerHTML = '';

    // Year 0 row (current state) - include agent purchase cost
    const totalInitialCosts = ctx.agentPurchaseCost || 0;
    const year0Invest = {
      y: 0,
      investNetWorth: Math.max(0, ctx.purchasePrice - ctx.loanAmount - totalInitialCosts) + Math.max(0, readNumber('pporValue') - readNumber('pporBalance')),
      propertyValue: ctx.purchasePrice,
      balance: ctx.loanAmount,
      pporValueInvest: readNumber('pporValue'),
      pporBalanceInvest: readNumber('pporBalance')
    };
    const year0NoInvest = {
      y: 0,
      noInvestNetWorth: Math.max(0, readNumber('pporValue') - Math.max(0, readNumber('pporBalance') - Math.max(0, (ctx.deposit||0))))
    };

    if (tbodyInvest){
      const tr0 = document.createElement('tr');
      tr0.innerHTML = `<td>0</td><td>${currency(Math.round(year0Invest.investNetWorth))}</td><td>${currency(Math.round(year0Invest.propertyValue))}</td><td>${currency(Math.round(year0Invest.balance))}</td><td>${currency(Math.round(year0Invest.pporValueInvest))}</td><td>${currency(Math.round(year0Invest.pporBalanceInvest))}</td>`;
      tbodyInvest.appendChild(tr0);
    }
    if (tbodyNoInvest){
      const tr0n = document.createElement('tr');
      tr0n.innerHTML = `<td>0</td><td>${currency(Math.round(year0NoInvest.noInvestNetWorth))}</td><td>${currency(Math.round(readNumber('pporValue')))}</td><td>${currency(Math.round(Math.max(0, readNumber('pporBalance') - Math.max(0, (ctx.deposit||0)))))}</td>`;
      tbodyNoInvest.appendChild(tr0n);
    }

    years.forEach(row => {
      if (tbodyInvest){
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.y}</td><td>${currency(Math.round(row.investNetWorth))}</td><td>${currency(Math.round(row.propertyValue))}</td><td>${currency(Math.round(row.balance))}</td><td>${currency(Math.round(row.pporValueInvest))}</td><td>${currency(Math.round(row.pporBalanceInvest))}</td>`;
        tbodyInvest.appendChild(tr);
      }
      if (tbodyNoInvest){
        const trn = document.createElement('tr');
        trn.innerHTML = `<td>${row.y}</td><td>${currency(Math.round(row.noInvestNetWorth))}</td><td>${currency(Math.round(row.pporValueNoInvest))}</td><td>${currency(Math.round(row.pporBalanceNoInvest))}</td>`;
        tbodyNoInvest.appendChild(trn);
      }
    });
  }

  function scalePoints(points, width, height, padding){
    const xs = points.map(p=>p.x);
    const ys = points.map(p=>p.y);
    const minX = Math.min(...xs, 0);
    const maxX = Math.max(...xs, 1);
    const minY = Math.min(...ys, 0);
    const maxY = Math.max(...ys, 1);
    const sx = (x)=> padding + (x - minX) * (width - 2*padding) / (maxX - minX || 1);
    const sy = (y)=> (height - padding) - (y - minY) * (height - 2*padding) / (maxY - minY || 1);
    return { sx, sy, minX, maxX, minY, maxY };
  }

  function drawChart(svgEl, points, opts){
    if (!svgEl) return;
    const width = 600, height = 240, pad = 32;
    svgEl.innerHTML = '';
    const { sx, sy, minY, maxY } = scalePoints(points, width, height, pad);
    // axes
    const axis = document.createElementNS('http://www.w3.org/2000/svg','path');
    axis.setAttribute('d', `M ${pad} ${pad} V ${height-pad} H ${width-pad}`);
    axis.setAttribute('stroke', '#273244'); axis.setAttribute('fill', 'none');
    svgEl.appendChild(axis);
    // zero line
    if (opts.zeroLine){
      const zy = sy(0);
      const zero = document.createElementNS('http://www.w3.org/2000/svg','line');
      zero.setAttribute('x1', pad); zero.setAttribute('x2', width-pad);
      zero.setAttribute('y1', zy); zero.setAttribute('y2', zy);
      zero.setAttribute('stroke', '#39465f'); zero.setAttribute('stroke-dasharray', '4 4');
      svgEl.appendChild(zero);
    }
    // path
    const d = points.map((p,i)=> `${i?'L':'M'} ${sx(p.x)} ${sy(p.y)}`).join(' ');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', opts.color || '#18a34a');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '2');
    svgEl.appendChild(path);
  }

  function drawMultiChart(svgEl, series, opts){
    if (!svgEl) return;
    const width = 600, height = 240, pad = 32;
    svgEl.innerHTML = '';
    const allPoints = series.flatMap(s=>s.points);
    const { sx, sy } = scalePoints(allPoints, width, height, pad);
    const axis = document.createElementNS('http://www.w3.org/2000/svg','path');
    axis.setAttribute('d', `M ${pad} ${pad} V ${height-pad} H ${width-pad}`);
    axis.setAttribute('stroke', '#273244'); axis.setAttribute('fill', 'none');
    svgEl.appendChild(axis);
    series.forEach(s => {
      const d = s.points.map((p,i)=> `${i?'L':'M'} ${sx(p.x)} ${sy(p.y)}`).join(' ');
      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', s.color || '#18a34a');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '2');
      svgEl.appendChild(path);
    });
  }

  function addTaxBracketRow(threshold, ratePct){
    const tbody = document.querySelector('#taxBracketsTable tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="tb-threshold" type="number" min="0" step="1000" value="${threshold}"></td>
      <td><input class="tb-rate" type="number" min="0" step="0.1" value="${ratePct}"></td>
    `;
    tbody.appendChild(tr);
    tr.querySelectorAll('input').forEach(inp => inp.addEventListener('input', recalc));
  }

  function addLmiRow(min, max, pct){
    const tbody = document.querySelector('#lmiTable tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="lmi-min" type="number" min="0" max="100" step="0.1" value="${min}"></td>
      <td><input class="lmi-max" type="number" min="0" max="100" step="0.1" value="${max}"></td>
      <td><input class="lmi-pct" type="number" min="0" max="20" step="0.01" value="${(pct*100).toFixed(2)}"></td>
    `;
    tbody.appendChild(tr);
    tr.querySelectorAll('input').forEach(inp => inp.addEventListener('input', recalc));
  }

  function initTables(){
    // tax brackets
    const tbody = document.querySelector('#taxBracketsTable tbody');
    tbody.innerHTML = '';
    defaultTaxBrackets.forEach(b => addTaxBracketRow(b.threshold, (b.rate*100).toFixed(2)));
    document.getElementById('addBracketBtn').addEventListener('click', () => {
      addTaxBracketRow(0, 0);
      recalc();
    });

    // lmi tiers
    const ltbody = document.querySelector('#lmiTable tbody');
    ltbody.innerHTML = '';
    defaultLmiTiers.forEach(t => addLmiRow(t.min, t.max, t.pct));
    document.getElementById('addLmiRowBtn').addEventListener('click', () => {
      addLmiRow(80, 85, 0.005);
      recalc();
    });
  }

  function bindInputs(){
    const ids = ['salarySelf','salarySpouse','purchasePrice','deposit','weeklyRent','interestRate','loanTermYears','loanType','ownershipSelfPct','upfrontCosts','councilRates','waterRates','landlordInsurance','maintenancePct','pmFeePct','depreciation','agentPurchasePct','agentSellingPct','marketingCosts','medicareRatePct','appreciationPct','horizonYears','altReturnPct','investDelayYears','pporExtraMonthly','pporValue','pporBalance','pporRate','pporTermYears','pporAppreciationPct'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', recalc);
      if (el && el.tagName === 'SELECT') el.addEventListener('change', recalc);
    });
    
    // Special handling for city selection
    const citySelect = document.getElementById('investmentCity');
    if (citySelect) {
      citySelect.addEventListener('change', handleCitySelection);
    }
  }

  window.CalculatorApp = {
    init(){
      initTables();
      bindInputs();
      recalc();
    }
  };
})();


