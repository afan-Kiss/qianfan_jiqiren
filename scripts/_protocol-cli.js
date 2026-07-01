/** 纯协议测试脚本共用 CLI 参数解析 */
function parseProtocolArgs(argv) {
  const out = {
    shop: '',
    listenMs: 30000,
    appCid: '',
    reallySend: false,
    reallyUpload: false,
    dryUpload: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop' || a === '-s') out.shop = String(argv[++i] || '').trim();
    else if (a === '--listen-ms') out.listenMs = Number(argv[++i]) || 30000;
    else if (a === '--app-cid') out.appCid = String(argv[++i] || '').trim();
    else if (a === '--really-send') out.reallySend = true;
    else if (a === '--really-upload') out.reallyUpload = true;
    else if (a === '--dry-upload') out.dryUpload = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printProtocolHelp(name, lines = []) {
  console.log(`用法: node scripts/${name} [options]`);
  for (const line of lines) console.log(`  ${line}`);
}

module.exports = { parseProtocolArgs, printProtocolHelp };
