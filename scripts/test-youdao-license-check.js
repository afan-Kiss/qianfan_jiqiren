const {
  verifyQianfanRelayLicense,
  fetchYoudaoSharePayload,
  parseSwitchStates,
  extractNoteText,
} = require('../src/shared/youdao-license-check');

async function main() {
  console.log('正在读取有道云笔记授权…');
  const payload = await fetchYoudaoSharePayload();
  const noteText = extractNoteText(payload);
  const states = parseSwitchStates(noteText);
  console.log('笔记摘要:', noteText);
  console.log('解析开关:', states);

  const result = await verifyQianfanRelayLicense();
  console.log('验证结果:', result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
