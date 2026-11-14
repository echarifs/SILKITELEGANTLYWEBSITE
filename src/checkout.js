import { countryNameOptionsMarkup, hydratePhoneCountrySelectors, phoneValueFromForm } from './phone-field.js';
import { splitPhoneNumber } from '../shared/phone.js';

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

// Same pen icon the account page uses for its edit buttons.
const PEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>';

export function mountCheckout({ cart, formatCurrency, showToast, updateCartCount, renderCartItems }) {
  if (!cart) throw new TypeError('Cart is required');
  hydratePhoneCountrySelectors(document);
  // The delivery country select mirrors the account page's country list.
  const shippingCountrySelect = document.querySelector('.checkout-shipping-form select[name="shippingCountry"]');
  if (shippingCountrySelect) shippingCountrySelect.insertAdjacentHTML('beforeend', countryNameOptionsMarkup());
  let paymentElement = null;
  let checkoutSession = null;
  let generation = 0;
  // Signed-in profile snapshot (null for guests) and whether the paid order
  // already carries a delivery address.
  let profile = null;
  let profileRequested = false;
  let shippingCaptured = false;

  const query = (selector) => document.querySelector(selector);
  const getStatus = () => query('.checkout-status');
  const setStatus = (message) => {
    const status = getStatus();
    if (status) status.textContent = message;
  };

  // Signed-in customers skip typing their details entirely: the order is built
  // from their profile behind the scenes and a summary line replaces the fields.
  function loadProfile() {
    profileRequested = true;
    fetch('/api/auth/me', { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (body?.user) {
          profile = body.user;
          prefillCheckoutForm();
          const saveBox = query('[data-checkout-save-account]');
          if (saveBox) saveBox.hidden = false;
        }
      })
      .catch(() => { /* guests simply keep typing manually */ });
  }

  function prefillCheckoutForm() {
    const form = query('.checkout-details-form');
    if (!form || form.hidden || !profile) return;
    // Fills empty fields from the profile and reports whether the value the
    // order would use really is the profile's (so a customer who already typed
    // something different keeps editing manually instead of seeing a summary).
    const owned = (selector, value) => {
      const input = form.querySelector(selector);
      if (!input) return false;
      if (!input.value && value) {
        input.value = String(value);
        return true;
      }
      return input.value.trim() === String(value ?? '').trim();
    };
    const nameOwned = owned('input[name="customerName"]', profile.name);
    const emailOwned = owned('input[name="customerEmail"]', profile.email);
    const identity = query('[data-checkout-identity]');
    const summary = query('[data-checkout-account-summary]');
    const pen = query('[data-checkout-identity-pen]');
    if (nameOwned && emailOwned && identity && summary && pen) {
      const phone = profile.phone ? ` · ${String(profile.phone)}` : '';
      summary.textContent = `Ordering as ${profile.name} (${profile.email})${phone}`;
      summary.hidden = false;
      identity.hidden = false;
      pen.innerHTML = PEN_ICON;
      const nameLabel = form.querySelector('input[name="customerName"]')?.closest('label');
      const emailLabel = form.querySelector('input[name="customerEmail"]')?.closest('label');
      if (nameLabel) nameLabel.hidden = true;
      if (emailLabel) emailLabel.hidden = true;
    }
    if (profile.phone) {
      const split = splitPhoneNumber(String(profile.phone));
      const phoneInput = form.querySelector('input[name="customerPhone"]');
      const countrySelect = form.querySelector('[data-phone-country="customerPhone"]');
      if (phoneInput && countrySelect && !phoneInput.value && split) {
        countrySelect.value = split.iso2;
        phoneInput.value = split.national;
        const phoneField = phoneInput.closest('.checkout-phone-field');
        if (phoneField) phoneField.hidden = true;
      }
    }
  }

  // The pen reopens the fields so the customer can verify or correct them.
  function revealIdentityFields() {
    const identity = query('[data-checkout-identity]');
    const form = query('.checkout-details-form');
    if (identity) identity.hidden = true;
    if (!form) return;
    for (const input of form.querySelectorAll('input[name="customerName"], input[name="customerEmail"]')) {
      const label = input.closest('label');
      if (label) label.hidden = false;
    }
    form.querySelector('.checkout-phone-field')?.removeAttribute('hidden');
    query('input[name="customerName"]')?.focus();
  }

  function shippingFromProfile() {
    if (!profile?.addressLine1?.trim()) return null;
    const city = String(profile.city || '').trim();
    const postalCode = String(profile.postalCode || '').trim();
    const country = String(profile.country || '').trim();
    if (!city || !postalCode || !country) return null;
    return {
      line1: profile.addressLine1,
      line2: profile.addressLine2 || '',
      city,
      postalCode,
      country,
    };
  }

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
    const shippingStage = query('.checkout-shipping-stage');
    const shippingForm = query('.checkout-shipping-form');
    const shippingSubmit = query('.checkout-shipping-submit');
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
      const identity = query('[data-checkout-identity]');
      if (identity) identity.hidden = true;
      const summary = query('[data-checkout-account-summary]');
      if (summary) {
        summary.hidden = true;
        summary.textContent = '';
      }
      const pen = query('[data-checkout-identity-pen]');
      if (pen) pen.setAttribute('aria-expanded', 'false');
      for (const input of form.querySelectorAll('input[name="customerName"], input[name="customerEmail"]')) {
        const label = input.closest('label');
        if (label) label.hidden = false;
      }
      const phoneField = form.querySelector('.checkout-phone-field');
      if (phoneField) phoneField.hidden = false;
    }
    if (paymentStage) paymentStage.hidden = true;
    if (shippingStage) shippingStage.hidden = true;
    if (shippingForm) shippingForm.reset();
    if (shippingSubmit) shippingSubmit.disabled = false;
    const shippingPhoneError = shippingForm?.querySelector('[data-phone-error="shippingPhone"]');
    if (shippingPhoneError) {
      shippingPhoneError.hidden = true;
      shippingPhoneError.textContent = '';
    }
    shippingCaptured = false;
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
    if (!profileRequested) loadProfile();
    prefillCheckoutForm();
    const nameField = query('input[name="customerName"]');
    // A guest types their details; a signed-in customer jumps straight to the button.
    if (nameField && nameField.closest('label')?.hidden) query('.checkout-create-session')?.focus();
    else nameField?.focus();
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
      const shipping = shippingFromProfile();
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
          // Signed-in customers with a saved address attach it here and skip
          // the post-payment delivery step.
          shipping: shipping ?? undefined,
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
      shippingCaptured = Boolean(shipping);
      checkoutSession = {
        ...body,
        customer: {
          name: String(formData.get('customerName') || '').trim(),
          email: String(formData.get('customerEmail') || '').trim(),
          phone: phone.value,
        },
      };
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
        if (shippingCaptured) {
          finishOrderStep(orderReference);
        } else {
          const paymentStage = query('.checkout-payment-stage');
          if (paymentStage) paymentStage.hidden = true;
          openShippingStep(orderReference);
        }
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

  function finishOrderStep(orderReference) {
    const shippingStage = query('.checkout-shipping-stage');
    if (shippingStage) shippingStage.hidden = true;
    const back = query('.checkout-back');
    if (back) {
      back.hidden = false;
      back.textContent = 'Return to cart';
    }
    setStatus(`Payment confirmed for order ${orderReference}. Your delivery details are saved, and a receipt email follows once YouCan Pay sends its signed confirmation.`);
  }

  // Mandatory post-payment delivery step for customers without a saved address.
  function openShippingStep(orderReference) {
    const stage = query('.checkout-shipping-stage');
    const back = query('.checkout-back');
    if (!stage) {
      finishOrderStep(orderReference);
      return;
    }
    back.hidden = true;
    const form = query('.checkout-shipping-form');
    const fill = (selector, value) => {
      const input = form?.querySelector(selector);
      if (input && value && !input.value) input.value = String(value);
    };
    fill('input[name="shippingLine1"]', profile?.addressLine1);
    fill('input[name="shippingLine2"]', profile?.addressLine2);
    fill('input[name="shippingCity"]', profile?.city);
    fill('input[name="shippingPostalCode"]', profile?.postalCode);
    if (profile?.country) {
      const countrySelect = form?.querySelector('select[name="shippingCountry"]');
      if (countrySelect) countrySelect.value = String(profile.country);
    }
    const saveBox = query('[data-checkout-save-account]');
    if (saveBox) {
      saveBox.hidden = !profile;
      const checkbox = saveBox.querySelector('input[name="saveAddressToAccount"]');
      if (checkbox) checkbox.checked = true;
    }
    // The order already carries a phone when it was captured at checkout.
    const phoneWrap = query('[data-checkout-shipping-phone]');
    if (phoneWrap) phoneWrap.hidden = Boolean(checkoutSession?.customer?.phone);
    stage.hidden = false;
    setStatus(`Payment submitted for order ${orderReference}. Now add the delivery details so we know where to send it.`);
    form?.querySelector('input[name="shippingLine1"]')?.focus();
  }

  async function persistAddressToAccount(values) {
    if (!profile) return;
    try {
      const csrfResponse = await fetch('/api/auth/csrf', { credentials: 'include', headers: { Accept: 'application/json' } });
      const csrf = await csrfResponse.json().catch(() => ({}));
      await fetch('/api/auth/address', {
        method: 'PUT',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': typeof csrf.csrfToken === 'string' ? csrf.csrfToken : '',
        },
        body: JSON.stringify({
          addressLine1: values.line1,
          addressLine2: values.line2,
          city: values.city,
          postalCode: values.postalCode,
          country: values.country,
        }),
      });
      profile = { ...profile, ...values };
    } catch {
      // The order still has its delivery details; show a gentle note only.
      setStatus('Delivery details are saved for this order. The address could not be stored on your account right now.');
    }
  }

  async function saveShippingDetails(event) {
    const form = event.target;
    const submit = query('.checkout-shipping-submit');
    const orderId = String(checkoutSession?.orderId || '');
    const email = String(checkoutSession?.customer?.email || '');
    const orderReference = String(checkoutSession.orderReference || orderId).slice(0, 32);
    if (shippingCaptured) {
      finishOrderStep(orderReference);
      return;
    }

    const values = {
      line1: String(form.querySelector('input[name="shippingLine1"]')?.value || '').trim(),
      line2: String(form.querySelector('input[name="shippingLine2"]')?.value || '').trim(),
      city: String(form.querySelector('input[name="shippingCity"]')?.value || '').trim(),
      postalCode: String(form.querySelector('input[name="shippingPostalCode"]')?.value || '').trim(),
      country: String(form.querySelector('select[name="shippingCountry"]')?.value || '').trim(),
    };
    const required = [
      ['line1', 'input[name="shippingLine1"]'],
      ['city', 'input[name="shippingCity"]'],
      ['postalCode', 'input[name="shippingPostalCode"]'],
      ['country', 'select[name="shippingCountry"]'],
    ];
    const missing = required.find(([key]) => !values[key]);
    if (missing) {
      setStatus('Please complete every delivery field except the optional second line.');
      form.querySelector(missing[1])?.focus();
      return;
    }

    let shippingPhone;
    const phoneWrap = query('[data-checkout-shipping-phone]');
    if (phoneWrap && !phoneWrap.hidden) {
      const phone = phoneValueFromForm(form, 'shippingPhone');
      if (!phone.ok) {
        setStatus(phone.message);
        phone.focus?.();
        return;
      }
      shippingPhone = phone.value;
    }
    if (submit) submit.disabled = true;
    setStatus('Saving your delivery details…');
    try {
      const payload = {
        orderId,
        email,
        line1: values.line1,
        line2: values.line2,
        city: values.city,
        postalCode: values.postalCode,
        country: values.country,
      };
      if (shippingPhone) payload.phone = shippingPhone;
      const response = await fetch('/api/payments/shipping-details', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && body.error !== 'shipping_already_set') {
        if (body.error === 'try_again_later') throw new Error('Too many attempts. Please wait a few minutes and try again.');
        if (body.error === 'order_not_found' || response.status === 404) {
          throw new Error('We could not match this order. Please contact us so we can confirm your delivery details.');
        }
        throw new Error('We could not save your delivery details. Please contact us so we can arrange delivery.');
      }
      shippingCaptured = true;
      const saveBox = query('[data-checkout-save-account]');
      const saveCheckbox = saveBox?.querySelector('input[name="saveAddressToAccount"]');
      if (profile && saveCheckbox?.checked) await persistAddressToAccount(values);
      finishOrderStep(orderReference);
    } catch (error) {
      setStatus(safeErrorMessage(error?.message));
      if (submit) submit.disabled = false;
    }
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
    if (event.target.closest('[data-checkout-identity-pen]')) {
      const pen = event.target.closest('[data-checkout-identity-pen]');
      pen.setAttribute('aria-expanded', 'true');
      revealIdentityFields();
      return;
    }
    const modal = query('#cart-modal');
    if (event.target.closest('.close-cart') || (modal && event.target === modal)) resetCheckout();
  });

  document.addEventListener('submit', (event) => {
    if (event.target.matches('.checkout-details-form')) void createCheckoutSession(event);
    else if (event.target.matches('.checkout-shipping-form')) void saveShippingDetails(event);
  });

  return resetCheckout;
}
