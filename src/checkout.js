import { hydratePhoneCountrySelectors, phoneValueFromForm } from './phone-field.js';

let sdkPromise;

function loadYouCanPaySdk() {
  if (typeof window.yp === 'function') return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://youcanpay.com/yp.js';
    script.async = true;
    script.dataset.youcanpaySdk = 'true';
    script.onload = () => typeof window.yp === 'function' ? resolve() : reject(new Error('Payment form unavailable'));
    script.onerror = () => reject(new Error('Payment form unavailable'));
    document.head.append(script);
  }).catch((error) => {
    sdkPromise = undefined;
    throw error;
  });
  return sdkPromise;
}

function safeErrorMessage(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 180) : 'Please try again or contact us for help.';
}

export function mountCheckout({ cart, formatCurrency, showToast, updateCartCount, renderCartItems }) {
  if (!cart) throw new TypeError('Cart is required');
  hydratePhoneCountrySelectors(document);
  let paymentElement = null;
  let checkoutSession = null;
  let generation = 0;

  const query = (selector) => document.querySelector(selector);
  const getStatus = () => query('.checkout-status');
  const setStatus = (message) => {
    const status = getStatus();
    if (status) status.textContent = message;
  };

  function resetCheckout() {
    generation += 1;
    try { paymentElement?.destroy?.(); } catch { /* provider iframe cleanup is best-effort */ }
    paymentElement = null;
    checkoutSession = null;
    const panel = query('.checkout-panel');
    const items = query('.cart-items');
    const checkoutButton = query('.checkout-btn');
    const whatsappButton = query('.checkout-whatsapp');
    const form = query('.checkout-details-form');
    const paymentStage = query('.checkout-payment-stage');
    const submit = query('.checkout-create-session');
    const confirm = query('.checkout-confirm-btn');
    const back = query('.checkout-back');
    if (panel) {
      panel.hidden = true;
      panel.setAttribute('aria-hidden', 'true');
    }
    if (items) items.hidden = false;
    if (checkoutButton) checkoutButton.hidden = false;
    if (whatsappButton) whatsappButton.hidden = false;
    if (form) {
      form.hidden = false;
      form.reset();
    }
    if (paymentStage) paymentStage.hidden = true;
    if (submit) submit.disabled = false;
    if (confirm) {
      confirm.disabled = true;
      confirm.hidden = false;
    }
    if (back) {
      back.hidden = false;
      back.textContent = 'Back to cart';
    }
    setStatus('');
  }

  function openCheckout() {
    if (!cart.getItems().length) {
      showToast?.('Your cart is empty');
      return;
    }
    resetCheckout();
    const panel = query('.checkout-panel');
    const items = query('.cart-items');
    const checkoutButton = query('.checkout-btn');
    const whatsappButton = query('.checkout-whatsapp');
    if (!panel) return;
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    if (items) items.hidden = true;
    if (checkoutButton) checkoutButton.hidden = true;
    if (whatsappButton) whatsappButton.hidden = true;
    query('input[name="customerName"]')?.focus();
  }

  async function createCheckoutSession(event) {
    event.preventDefault();
    if (!cart.getItems().length) {
      showToast?.('Your cart is empty');
      resetCheckout();
      return;
    }
    // This handler is delegated from document, so currentTarget is document.
    // Use the submitted form itself for validation and FormData construction.
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submit = query('.checkout-create-session');
    const paymentStage = query('.checkout-payment-stage');
    const generationAtStart = generation;
    const phone = phoneValueFromForm(form, 'customerPhone');
    if (!phone.ok) {
      setStatus(phone.message);
      phone.focus?.();
      return;
    }
    if (submit) submit.disabled = true;
    setStatus('Preparing a secure sandbox payment…');
    try {
      const formData = new FormData(form);
      const response = await fetch('/api/payments/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: {
            name: String(formData.get('customerName') || '').trim(),
            email: String(formData.get('customerEmail') || '').trim(),
            phone: phone.value,
          },
          items: cart.getItems().map((item) => ({
            productId: item.productId,
            option: item.option,
            quantity: item.quantity,
          })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.error === 'sandbox_payments_not_configured') {
          throw new Error('Sandbox payment credentials have not been configured yet. Please contact us to place your order.');
        }
        if (body.error === 'try_again_later') throw new Error('Too many checkout attempts. Please wait a few minutes and try again.');
        if (body.error === 'invalid_cart' || body.error === 'invalid_checkout') throw new Error('Please check your cart and contact details, then try again.');
        throw new Error('We could not start the payment. Please try again or contact us for help.');
      }
      if (generationAtStart !== generation) return;
      if (body.mode !== 'sandbox' || typeof body.token !== 'string' || typeof body.publicKey !== 'string') {
        throw new Error('The sandbox payment response was incomplete. Please try again.');
      }
      checkoutSession = body;
      if (paymentStage) paymentStage.hidden = false;
      form.hidden = true;
      setStatus('Loading YouCan Pay’s secure card form…');
      await loadYouCanPaySdk();
      if (generationAtStart !== generation) return;
      const confirmButton = query('.checkout-confirm-btn');
      paymentElement = window.yp(body.publicKey).elements({
        token: body.token,
        container: '#youcanpay-element',
        gateways: ['credit-card'],
        appearance: {
          variables: {
            primary: '#b47f92',
            'primary-hover': '#98677a',
            'primary-foreground': '#ffffff',
            background: '#fffdfc',
            foreground: '#2f2523',
            'muted-foreground': '#756a69',
            border: '#eadfdb',
            radius: '12px',
            font: 'Arial, sans-serif',
          },
        },
      });
      paymentElement.on('ready', () => {
        if (generationAtStart !== generation) return;
        if (confirmButton) confirmButton.disabled = false;
        setStatus('Enter your card details in the secure YouCan Pay form. YouCan Pay will show a 3-D Secure challenge if your card requires it.');
      });
      paymentElement.on('error', () => {
        if (generationAtStart !== generation) return;
        if (confirmButton) confirmButton.disabled = true;
        setStatus('The secure card form could not load. Please return to the cart and try again.');
      });
      await paymentElement.mount();
    } catch (error) {
      if (generationAtStart !== generation) return;
      if (submit) submit.disabled = false;
      if (paymentStage && !checkoutSession) paymentStage.hidden = true;
      if (form && !checkoutSession) form.hidden = false;
      setStatus(safeErrorMessage(error?.message));
    }
  }

  async function confirmPayment() {
    const button = query('.checkout-confirm-btn');
    if (!paymentElement || !checkoutSession || !button || button.disabled) return;
    button.disabled = true;
    setStatus('Confirming with YouCan Pay…');
    try {
      const result = await paymentElement.confirm();
      if (result?.status === 'succeeded') {
        const orderReference = String(checkoutSession.orderReference || checkoutSession.orderId || '').slice(0, 32);
        for (const item of cart.getItems()) cart.removeItem(item.key);
        updateCartCount?.();
        renderCartItems?.();
        button.hidden = true;
        const back = query('.checkout-back');
        if (back) back.textContent = 'Return to cart';
        setStatus(`Payment submitted for order ${orderReference}. We are waiting for YouCan Pay’s signed confirmation. A receipt email can be sent once the store’s email service is verified.`);
      } else {
        const message = result?.error?.message;
        setStatus(safeErrorMessage(message));
        button.disabled = false;
      }
    } catch {
      setStatus('The payment could not be confirmed. Please try again or contact us for help.');
      button.disabled = false;
    }
  }

  function checkoutByWhatsApp() {
    const items = cart.getItems();
    if (!items.length) {
      showToast?.('Your cart is empty');
      return;
    }
    const lines = items
      .map((item) => `• ${item.productName} (${item.option}) × ${item.quantity} — ${formatCurrency(item.price * item.quantity)}`)
      .join('\n');
    const message = `Hello SilkItElegantly, I'd like to order:\n${lines}\n\nTotal: ${formatCurrency(cart.getTotal())}`;
    window.open(`https://wa.me/33768353638?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('.checkout-btn')) {
      openCheckout();
      return;
    }
    if (event.target.closest('.checkout-whatsapp')) {
      checkoutByWhatsApp();
      return;
    }
    if (event.target.closest('.checkout-back')) {
      resetCheckout();
      return;
    }
    if (event.target.closest('.checkout-confirm-btn')) {
      void confirmPayment();
      return;
    }
    const modal = query('#cart-modal');
    if (event.target.closest('.close-cart') || (modal && event.target === modal)) resetCheckout();
  });

  document.addEventListener('submit', (event) => {
    if (event.target.matches('.checkout-details-form')) void createCheckoutSession(event);
  });

  return resetCheckout;
}
