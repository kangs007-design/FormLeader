'use strict';
/**
 * 서버 PC 에서 비밀번호를 초기화한다. (관리자가 비밀번호를 잊었을 때)
 *   npm run reset:password -- 사용자@회사.com
 * 임시 비밀번호가 한 번만 출력되며, 로그인하면 새 비밀번호로 바꿔야 한다. 서버를 끌 필요는 없다.
 */
const { createConfig } = require('../src/common/app.config');
const { AuthService } = require('../src/features/auth/auth.service');

(async () => {
  const email = process.argv[2];
  if (!email) throw new Error('사용법: npm run reset:password -- 이메일');
  const config = createConfig();
  const auth = new AuthService(config);
  await auth.init(config.port);
  try {
    const user = auth.findByEmail(email);
    if (!user) throw new Error(`등록되지 않은 이메일입니다: ${email}`);
    const result = await auth.resetPassword('server-console', user.id);
    console.log(`\n계정     : ${result.email} (${result.name}, ${user.role === 'admin' ? '관리자' : '일반 사용자'})`);
    console.log(`임시 비밀번호 : ${result.temporaryPassword}`);
    console.log('로그인한 뒤 새 비밀번호로 변경해 주세요. 기존 로그인은 모두 종료되었습니다.');
    if (user.status !== 'active') console.log(`주의: 계정 상태가 "${user.status}" 이므로 로그인할 수 없습니다.`);
  } finally { auth.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
