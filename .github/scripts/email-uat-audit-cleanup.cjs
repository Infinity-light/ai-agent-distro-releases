'use strict';

const { createHash } = require('node:crypto');
const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [process.cwd()] }));

const EXPECTED_USER_ID = '12245f73-a49c-473f-abc6-9c3f2a721376';
const EXPECTED_DESTINATION_HASH12 = '7de14826091b';
const UAT_WINDOW_START = new Date('2026-08-22T17:20:00.000Z');
const UAT_WINDOW_END = new Date('2026-08-22T17:40:00.000Z');
const prisma = new PrismaClient();

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha12 = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const opaqueRef = (value) => value
  ? { suffix: String(value).slice(-6), sha256Prefix: sha12(value) }
  : null;
const inUatWindow = (value) => {
  const time = new Date(value).getTime();
  return time >= UAT_WINDOW_START.getTime() && time <= UAT_WINDOW_END.getTime();
};
const beijing = (value = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}).format(new Date(value));

async function main() {
  const user = await prisma.user.findUnique({
    where: { id: EXPECTED_USER_ID },
    select: {
      id: true,
      name: true,
      phone: true,
      emailNormalized: true,
      emailVerifiedAt: true,
      role: true,
      createdAt: true,
    },
  });
  assert(user, 'The exact synthetic UAT account does not exist');
  assert(user.name.startsWith('Fleet Email UAT '), 'Unexpected UAT account marker');
  assert(/^199\d{8}$/.test(user.phone), 'Unexpected UAT phone marker');
  assert(user.role === 'TERMINAL_USER', 'Unexpected UAT role');
  assert(user.emailNormalized && user.emailVerifiedAt, 'UAT email is not bound and verified');
  assert(inUatWindow(user.createdAt), 'UAT account is outside the fixed audit window');
  assert(sha12(user.emailNormalized) === EXPECTED_DESTINATION_HASH12, 'Destination hash mismatch');

  const challenges = await prisma.verificationChallenge.findMany({
    where: { subjectUserId: EXPECTED_USER_ID },
    select: {
      id: true,
      channel: true,
      destination: true,
      purpose: true,
      providerRequestId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const challengeIds = challenges.map(({ id }) => id);
  const purposeByChallenge = new Map(challenges.map(({ id, purpose }) => [id, purpose]));
  const outboxes = await prisma.verificationOutbox.findMany({
    where: { challengeId: { in: challengeIds } },
    select: {
      id: true,
      challengeId: true,
      channel: true,
      destination: true,
      status: true,
      providerRequestId: true,
      attempts: true,
      createdAt: true,
      sentAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  assert(challenges.every(({ createdAt }) => inUatWindow(createdAt)), 'Challenge outside the fixed UAT window');
  assert(outboxes.every(({ createdAt }) => inUatWindow(createdAt)), 'Outbox outside the fixed UAT window');
  assert(challenges.every(({ destination }) => sha12(destination) === EXPECTED_DESTINATION_HASH12), 'Challenge destination mismatch');
  assert(outboxes.every(({ destination }) => sha12(destination) === EXPECTED_DESTINATION_HASH12), 'Outbox destination mismatch');

  const smsChallenges = challenges.filter(({ channel }) => channel === 'SMS');
  const smsOutboxes = outboxes.filter(({ channel }) => channel === 'SMS');
  const smsProviderRequestCount = smsChallenges.filter(({ providerRequestId }) => providerRequestId).length
    + smsOutboxes.filter(({ providerRequestId }) => providerRequestId).length;
  assert(smsChallenges.length === 0, 'SMS challenge exists');
  assert(smsOutboxes.length === 0, 'SMS outbox exists');
  assert(smsProviderRequestCount === 0, 'SMS provider request exists');

  const emailOutboxes = outboxes.filter(({ channel }) => channel === 'EMAIL');
  assert(challenges.length === 3, 'Expected exactly three email challenges');
  assert(emailOutboxes.length === 3, 'Expected exactly three email outboxes');
  assert(emailOutboxes.every(({ status, providerRequestId, sentAt }) => status === 'SENT' && providerRequestId && sentAt),
    'Email outbox evidence is incomplete');
  const purposes = emailOutboxes.map(({ challengeId }) => purposeByChallenge.get(challengeId));
  assert(purposes.filter((purpose) => purpose === 'BIND_EMAIL').length === 1, 'Expected one binding outbox');
  assert(purposes.filter((purpose) => purpose === 'PASSWORD_RESET').length === 2, 'Expected two reset outboxes');

  console.log(`EMAIL_UAT_AUDIT=${JSON.stringify({
    atBeijing: beijing(),
    userRef: opaqueRef(EXPECTED_USER_ID),
    destinationHash12: EXPECTED_DESTINATION_HASH12,
    uatWindow: { start: UAT_WINDOW_START.toISOString(), end: UAT_WINDOW_END.toISOString() },
    challengeCount: challenges.length,
    smsChallengeCount: smsChallenges.length,
    smsOutboxCount: smsOutboxes.length,
    smsProviderRequestCount,
    emailOutboxes: emailOutboxes.map((outbox) => ({
      purpose: purposeByChallenge.get(outbox.challengeId),
      status: outbox.status,
      directMailEnvRef: opaqueRef(outbox.providerRequestId),
      attempts: outbox.attempts,
      sentAtBeijing: beijing(outbox.sentAt),
    })),
    directResetNoticeControlPlaneCorrelation: 'NOT_PERSISTED_BY_DIRECT_SEND_PATH',
  })}`);

  await prisma.$transaction(async (tx) => {
    await tx.agreement.deleteMany({ where: { userId: EXPECTED_USER_ID } });
    await tx.user.delete({ where: { id: EXPECTED_USER_ID } });
  });

  const [remainingUser, remainingChallenges, remainingOutboxes, remainingAgreements] = await Promise.all([
    prisma.user.count({ where: { id: EXPECTED_USER_ID } }),
    prisma.verificationChallenge.count({ where: { subjectUserId: EXPECTED_USER_ID } }),
    prisma.verificationOutbox.count({ where: { id: { in: outboxes.map(({ id }) => id) } } }),
    prisma.agreement.count({ where: { userId: EXPECTED_USER_ID } }),
  ]);
  assert(remainingUser === 0, 'Synthetic UAT user cleanup failed');
  assert(remainingChallenges === 0, 'Synthetic UAT challenge cleanup failed');
  assert(remainingOutboxes === 0, 'Synthetic UAT outbox cleanup failed');
  assert(remainingAgreements === 0, 'Synthetic UAT agreement cleanup failed');

  console.log(`EMAIL_UAT_CLEANUP=${JSON.stringify({
    atBeijing: beijing(),
    userRef: opaqueRef(EXPECTED_USER_ID),
    remainingUser,
    remainingChallenges,
    remainingOutboxes,
    remainingAgreements,
    sessionState: 'STATELESS_JWT_SUBJECT_DELETED',
  })}`);
}

main()
  .finally(() => prisma.$disconnect());
