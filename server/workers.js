import { processAccountMail } from './mail-queue.js';
import { cleanupAuthState } from './cleanup.js';
import { processPaymentEmailJobs } from './payment-mail-queue.js';

export function startAccountWorkers({ pool, mail, allowedOrigins }) {
  let mailTask = null;
  let paymentMailTask = null;
  let cleanupTask = null;
  let stopped = false;
  function runMail() {
    if (stopped || mailTask || !mail.configured) return;
    mailTask = processAccountMail(pool, mail, { allowedOrigins, batchSize: 5 })
      .catch(() => console.warn('Account email queue needs attention; retry state remains in the database.'))
      .finally(() => { mailTask = null; });
  }
  function runCleanup() {
    if (stopped || cleanupTask) return;
    cleanupTask = cleanupAuthState(pool)
      .catch(() => console.warn('Authentication record cleanup could not finish.'))
      .finally(() => { cleanupTask = null; });
  }
  function runPaymentMail() {
    if (stopped || paymentMailTask || !mail.configured) return;
    paymentMailTask = processPaymentEmailJobs(pool, mail, { batchSize: 5 })
      .catch(() => console.warn('Payment email queue needs attention; retry state remains in the database.'))
      .finally(() => { paymentMailTask = null; });
  }
  const mailTimer = setInterval(runMail, 30000);
  const paymentMailTimer = setInterval(runPaymentMail, 30000);
  const cleanupTimer = setInterval(runCleanup, 15 * 60 * 1000);
  mailTimer.unref();
  paymentMailTimer.unref();
  cleanupTimer.unref();
  runMail();
  runPaymentMail();
  runCleanup();
  return async function stop() {
    stopped = true;
    clearInterval(mailTimer);
    clearInterval(paymentMailTimer);
    clearInterval(cleanupTimer);
    await Promise.allSettled([mailTask, paymentMailTask, cleanupTask].filter(Boolean));
  };
}
