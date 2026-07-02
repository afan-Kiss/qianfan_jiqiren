(() => {
  const $ = (id) => document.getElementById(id);
  let lastRows = [];
  let exportColumns = [];
  let apiBase = '';

  const FALLBACK_COLUMNS = [
    ['shopTitle', '配置店铺'],
    ['orderId', '订单号'],
    ['packageId', '包裹号'],
    ['status', '状态'],
    ['buyerNick', '用户名'],
    ['buyerUserId', '用户ID'],
    ['recipientName', '收件人'],
    ['phonePlain', '手机号'],
    ['addressPlain', '收货地址'],
    ['phoneMasked', '手机号(脱敏)'],
    ['addressMasked', '地址(脱敏)'],
    ['shopName', '商家名称'],
    ['sellerId', '商家ID'],
    ['warehouse', '发货仓'],
    ['expressNo', '运单号'],
    ['expressCompany', '快递公司'],
    ['createTime', '创建时间'],
    ['payTime', '支付时间'],
    ['shipTime', '发货时间'],
    ['expectSendTime', '预计发货'],
    ['finishTime', '完成时间'],
    ['rawPrice', '原价'],
    ['dealPrice', '成交价'],
    ['customerPayAmount', '实付金额'],
    ['transPrice', '运费'],
    ['payMethod', '支付方式'],
    ['payStatus', '支付状态'],
    ['orderType', '订单类型'],
    ['logisticsMode', '物流模式'],
    ['sendFrom', '发货地'],
    ['cancelApplied', '取消申请'],
    ['packageStatus', '包裹状态码'],
    ['erpStatus', 'ERP状态'],
    ['productNames', '商品名称'],
    ['productSpecs', '规格'],
    ['quantities', '数量'],
    ['productPrices', '单价'],
    ['categories', '类目'],
    ['skuCodes', 'SKU编码'],
    ['afterSaleStatuses', '售后状态'],
    ['canReadAddress', '可读地址'],
    ['decryptOk', '解密成功'],
    ['decryptError', '解密错误'],
  ];

  function setLoading(on, text) {
    $('loading').classList.toggle('hidden', !on);
    if (text) $('loadingText').textContent = text;
  }

  function defaultDates() {
    const end = new Date();
    const begin = new Date();
    begin.setDate(end.getDate() - 7);
    const fmt = (d) => d.toISOString().slice(0, 10);
    $('dateBegin').value = fmt(begin);
    $('dateEnd').value = fmt(end);
  }

  function normalizeApiBase(url) {
    return String(url || '').trim().replace(/\/$/, '');
  }

  async function initApiBase() {
    const saved = localStorage.getItem('qianfanOrderApiBase');
    if (saved) {
      apiBase = normalizeApiBase(saved);
      $('apiBase').value = apiBase;
      return;
    }
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      apiBase = normalizeApiBase(cfg.orderApiBase);
      $('apiBase').value = apiBase;
    } catch {
      apiBase = 'http://127.0.0.1:35872';
      $('apiBase').value = apiBase;
    }
  }

  function saveApiBase() {
    apiBase = normalizeApiBase($('apiBase').value);
    if (!apiBase) {
      alert('请填写拉单 API 地址');
      return;
    }
    localStorage.setItem('qianfanOrderApiBase', apiBase);
    $('shopMeta').textContent = `拉单 API：${apiBase}\n请点击搜索加载店铺`;
    loadShops().catch(() => {});
  }

  function apiUrl(path) {
    if (!apiBase) throw new Error('请先配置拉单 API 地址');
    return `${apiBase}${path}`;
  }

  async function loadExportColumns() {
    try {
      const res = await fetch(apiUrl('/api/export-columns'));
      const data = await res.json();
      exportColumns = Array.isArray(data.columns) && data.columns.length ? data.columns : FALLBACK_COLUMNS;
    } catch {
      exportColumns = FALLBACK_COLUMNS;
    }
  }

  async function loadShops() {
    const res = await fetch(apiUrl('/api/shops'));
    const data = await res.json();
    const select = $('shopSelect');
    select.innerHTML = '';
    const shops = data.shops || [];
    for (const shop of shops) {
      const opt = document.createElement('option');
      opt.value = shop.shopTitle;
      opt.textContent = `${shop.shopTitle}${shop.sellerId ? '' : ' (缺sellerId)'}`;
      opt.selected = true;
      select.appendChild(opt);
    }
    $('shopMeta').textContent =
      shops.length > 0
        ? `拉单 API：${apiBase}\n已接入 ${shops.length} 店铺（服务器千帆 Cookie）`
        : `拉单 API：${apiBase}\n服务器未返回可用店铺`;
  }

  function selectedShops() {
    return Array.from($('shopSelect').selectedOptions).map((o) => o.value);
  }

  function buildQueryBody() {
    return {
      shopTitles: selectedShops(),
      dateBegin: $('dateBegin').value,
      dateEnd: $('dateEnd').value,
      status: $('statusSelect').value,
      searchType: $('searchType').value,
      searchText: $('searchText').value.trim(),
      autoDecrypt: true,
      fetchDetail: true,
    };
  }

  function renderStats(result) {
    const stats = result.stats || {};
    const shopLines = (stats.shops || [])
      .map((s) => `${s.shopTitle}: ${s.returned ?? s.fetched ?? 0}条${s.error ? ` (${s.error})` : ''}`)
      .join(' · ');
    $('statsBar').textContent =
      `列表 ${lastRows.length} 条 · 已自动解密 ${stats.decryptOk || 0} 条 · 耗时 ${((stats.elapsedMs || 0) / 1000).toFixed(1)}s${shopLines ? ` · ${shopLines}` : ''}`;
  }

  function renderTable(rows) {
    const body = $('orderBody');
    body.innerHTML = '';
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="18" class="empty">暂无数据</td></tr>';
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      const cells = [
        row.orderId,
        row.packageId,
        row.status,
        row.buyerNick,
        row.buyerUserId,
        row.phonePlain || row.phoneMasked,
        row.recipientName,
        row.shopName,
        row.warehouse,
        row.addressPlain || row.addressMasked,
        row.expressNo,
        row.createTime,
        row.payTime,
        row.customerPayAmount,
        row.productNames,
        row.productSpecs,
        row.quantities,
        row.afterSaleStatuses,
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text ?? '';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  async function search() {
    if (!apiBase) {
      alert('请先填写并保存拉单 API 地址');
      return;
    }
    const body = buildQueryBody();
    if (!body.shopTitles.length) {
      alert('请至少选择一个店铺');
      return;
    }
    setLoading(true, '正在通过服务器拉单并自动解密手机号/地址...');
    $('btnSearch').disabled = true;
    $('btnExport').disabled = true;
    try {
      const res = await fetch(apiUrl('/api/orders/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || '查询失败');
      lastRows = result.rows || [];
      renderStats(result);
      renderTable(lastRows);
      $('btnExport').disabled = lastRows.length === 0;
    } catch (err) {
      alert(err.message || String(err));
      $('statsBar').textContent = `查询失败：${err.message || err}`;
    } finally {
      setLoading(false);
      $('btnSearch').disabled = false;
    }
  }

  function rowsToCsv(rows, columns) {
    const cols = columns.length ? columns : FALLBACK_COLUMNS;
    const header = cols.map(([, label]) => label);
    const keys = cols.map(([key]) => key);
    const esc = (v) => {
      const s = String(v ?? '');
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [header.map(esc).join(',')];
    for (const row of rows) {
      lines.push(keys.map((k) => esc(row[k])).join(','));
    }
    return `\uFEFF${lines.join('\n')}`;
  }

  function exportExcel() {
    if (!lastRows.length) {
      alert('列表为空，请先搜索');
      return;
    }
    const csv = rowsToCsv(lastRows, exportColumns);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `千帆订单_${$('dateBegin').value}_${$('dateEnd').value}_${lastRows.length}条.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function resetFilters() {
    $('statusSelect').value = 'all';
    $('searchType').value = 'all';
    $('searchText').value = '';
    defaultDates();
  }

  $('btnSearch').addEventListener('click', search);
  $('btnExport').addEventListener('click', exportExcel);
  $('btnReset').addEventListener('click', resetFilters);
  $('btnSaveApi').addEventListener('click', saveApiBase);

  defaultDates();
  initApiBase()
    .then(() => loadExportColumns())
    .then(() => loadShops())
    .catch((err) => {
      $('shopMeta').textContent = `初始化失败：${err.message || err}`;
    });
})();
