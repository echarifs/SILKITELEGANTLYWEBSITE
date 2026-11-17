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

const WHATSAPP_ORDER_NUMBER = '33768353638';

export function mountCheckout({ cart, formatCurrency, showToast, updateCartCount, renderCartItems }) {
  if (!cart) throw new TypeError('Cart is required');
  let paymentElement = null;
  let checkoutSession = null;
  let generation = 0;
  // Signed-in profile snapshot (null for guests) and whether the paid order
  // already carries a delivery address.
  let profile = null;
  let shippingCaptured = false;
  // The confirmed cash-on-delivery or bank-transfer order, kept so the
  // confirmation step can still hand the details over to WhatsApp.
  let placedOrder = null;
  let placedDetails = null;

  const query = (selector) => document.querySelector(selector);
  const getStatus = () => query('.checkout-status');
  const setStatus = (message) => {
    const status = getStatus();
    if (status) status.textContent = message;
  };

  // Every route change re-renders the cart markup, so the country lists are
  // filled when the checkout opens. Both helpers are idempotent.
  function ensureCheckoutSelects() {
    hydratePhoneCountrySelectors(document);
    // Both country selects (checkout details + post-payment delivery form)
    // mirror the account page's country list.
    for (const scope of ['.checkout-details-form', '.checkout-shipping-form']) {
      const countrySelect = document.querySelector(`${scope} select[name="shippingCountry"]`);
      if (countrySelect && countrySelect.options.length <= 1) {
        countrySelect.insertAdjacentHTML('beforeend', countryNameOptionsMarkup());
      }
    }
  }

  // Signed-in customers skip typing their details entirely: the order is built
  // from their profile behind the scenes and a summary line replaces the fields.
  function loadProfile() {
    fetch('/api/auth/me', { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (body?.user) {
          profile = body.user;
          prefillCheckoutForm();
          const saveBox = query('[data-checkout-save-account]');
          if (saveBox) saveBox.hidden = false;
          const codSaveBox = query('[data-checkout-save-cod-address]');
          if (codSaveBox) codSaveBox.hidden = false;
        }
      })
      .catch(() => { /* guests simply keep typing manually */ });
  }

  // Fills empty fields from the profile and reports whether the value the
  // order would use really is the profile's (so a customer who already typed
  // something different keeps editing manually instead of seeing a summary).
  function owned(form, selector, value) {
    const input = form.querySelector(selector);
    if (!input) return false;
    const expected = String(value ?? '');
    if (!input.value && expected) {
      input.value = expected;
      return true;
    }
    return input.value.trim() === expected.trim();
  }

  function prefillCheckoutForm() {
    const form = query('.checkout-details-form');
    if (!form || form.hidden || !profile) return;
    const nameOwned = owned(form, 'input[name="customerName"]', profile.name);
    const emailOwned = owned(form, 'input[name="customerEmail"]', profile.email);
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

    // Saved delivery address: same summary + pen treatment as the identity line.
    const address = profileAddress();
    const addressSummary = query('[data-checkout-address-summary]');
    const addressPen = query('[data-checkout-address-pen]');
    const addressBlock = query('[data-checkout-address]');
    if (address && addressSummary && addressPen && addressBlock) {
      const line1Owned = owned(form, 'input[name="shippingLine1"]', address.line1);
      const line2Owned = owned(form, 'input[name="shippingLine2"]', address.line2 || '');
      const cityOwned = owned(form, 'input[name="shippingCity"]', address.city);
      const postalOwned = owned(form, 'input[name="shippingPostalCode"]', address.postalCode);
      const countrySelect = form.querySelector('select[name="shippingCountry"]');
      let countryOwned = false;
      if (countrySelect) {
        if (!countrySelect.value && countrySelect.options.length > 1) {
          countrySelect.value = address.country;
          countryOwned = true;
        } else {
          countryOwned = countrySelect.value === address.country;
        }
      }
      if (line1Owned && line2Owned && cityOwned && postalOwned && countryOwned) {
        hideAddressFields(form);
        const second = address.line2 ? `, ${address.line2}` : '';
        addressSummary.textContent = `Delivering to: ${address.line1}${second}, ${address.city} ${address.postalCode}, ${countryName(address.country)}`;
        addressSummary.hidden = false;
        addressBlock.hidden = false;
        addressPen.innerHTML = PEN_ICON;
      } else {
        // A partially-saved address stays editable; fill what we can.
        if (cityOwned && !line2Owned) owned(form, 'input[name="shippingLine2"]', '');
      }
    }
    updateCodAvailability();
  }

  function profileAddress() {
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

  // Cash on delivery only serves Morocco and Western Sahara; the option stays
  // visible for everyone but is disabled with a note outside those, while
  // bank transfer and WhatsApp serve everyone.
  const COD_COUNTRIES = new Set(['MA', 'EH']);
  function updateCodAvailability() {
    const countrySelect = query('.checkout-details-form select[name="shippingCountry"]');
    const country = String(countrySelect?.value || '').trim().toUpperCase();
    const codAvailable = COD_COUNTRIES.has(country);
    const codButton = query('.checkout-confirm-cod');
    if (codButton) codButton.disabled = !codAvailable;
    const note = query('[data-checkout-cod-note]');
    if (!note) return;
    note.hidden = codAvailable;
    note.textContent = country
      ? 'Oops — cash on delivery is only available in Morocco and Western Sahara. You can either pay by bank transfer or through WhatsApp.'
      : 'Cash on delivery is only available in Morocco and Western Sahara.';
  }

  function countryName(iso2) {
    const countrySelect = document.querySelector('.checkout-details-form select[name="shippingCountry"]');
    const option = countrySelect instanceof HTMLSelectElement
      ? Array.from(countrySelect.options).find((candidate) => candidate.value === iso2)
      : null;
    return option ? option.textContent : iso2;
  }

  function hideAddressFields(form) {
    for (const node of form.querySelectorAll('[data-checkout-address-label]')) {
      node.hidden = true;
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

  function revealAddressFields() {
    const addressBlock = query('[data-checkout-address]');
    const form = query('.checkout-details-form');
    if (addressBlock) addressBlock.hidden = true;
    if (!form) return;
    for (const node of form.querySelectorAll('[data-checkout-address-label]')) {
      node.removeAttribute('hidden');
    }
    form.querySelector('input[name="shippingLine1"]')?.focus();
  }

  function resetCheckout() {
    generation += 1;
    try { paymentElement?.destroy?.(); } catch { /* provider iframe cleanup is best-effort */ }
    paymentElement = null;
    checkoutSession = null;
    placedOrder = null;
    placedDetails = null;
    const panel = query('.checkout-panel');
    const items = query('.cart-items');
    const checkoutButton = query('.checkout-btn');
    const whatsappButton = query('.checkout-whatsapp');
    const form = query('.checkout-details-form');
    const paymentStage = query('.checkout-payment-stage');
    const orderStage = query('.checkout-order-stage');
    const shippingStage = query('.checkout-shipping-stage');
    const shippingForm = query('.checkout-shipping-form');
    const shippingSubmit = query('.checkout-shipping-submit');
    const submit = query('.checkout-confirm-cod');
    const submitTransfer = query('.checkout-confirm-transfer');
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
      const addressBlock = query('[data-checkout-address]');
      if (addressBlock) addressBlock.hidden = true;
      const addressSummary = query('[data-checkout-address-summary]');
      if (addressSummary) {
        addressSummary.hidden = true;
        addressSummary.textContent = '';
      }
      const addressPen = query('[data-checkout-address-pen]');
      if (addressPen) {
        addressPen.setAttribute('aria-expanded', 'false');
        addressPen.innerHTML = '';
      }
      for (const node of form.querySelectorAll('[data-checkout-address-label]')) {
        node.removeAttribute('hidden');
      }
      const codSaveBox = query('[data-checkout-save-cod-address]');
      if (codSaveBox) codSaveBox.hidden = true;
    }
    if (paymentStage) paymentStage.hidden = true;
    if (orderStage) {
      orderStage.hidden = true;
      const message = orderStage.querySelector('[data-checkout-order-message]');
      const summary = orderStage.querySelector('[data-checkout-order-summary]');
      if (message) message.textContent = '';
      if (summary) summary.textContent = '';
    }
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
    if (submitTransfer) submitTransfer.disabled = false;
    if (confirm) {
      confirm.disabled = true;
      confirm.hidden = false;
    }
    if (back) {
      back.hidden = false;
      back.textContent = 'Back to cart';
    }
    updateCodAvailability();
    setStatus('');
  }

  function openCheckout() {
    if (!cart.getItems().length) {
      showToast?.('Your cart is empty');
      return;
    }
    resetCheckout();
    if (profile) {
      const codSaveBox = query('[data-checkout-save-cod-address]');
      if (codSaveBox) codSaveBox.hidden = false;
    }
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
    // Ask again whenever the profile is unknown: a customer may sign in after
    // this page loaded, so a missing profile is never treated as permanent.
    if (!profile) loadProfile();
    ensureCheckoutSelects();
    prefillCheckoutForm();
    updateCodAvailability();
    const nameField = query('input[name="customerName"]');
    // A guest types their details; a signed-in customer jumps straight to the button.
    if (nameField && nameField.closest('label')?.hidden) query('.checkout-confirm-cod')?.focus();
    else nameField?.focus();
  }

  // Shared validation so cash-on-delivery, card, and WhatsApp orders all carry
  // the same required contact + delivery details. The `focus` entry is a
  // zero-arg function callers invoke with `details.focus?.()`.
  function validateDetails(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    const focusField = (element) => (element ? () => element.focus() : undefined);
    const phone = phoneValueFromForm(form, 'customerPhone');
    if (!phone.ok) {
      return { ok: false, message: phone.message, focus: focusField(phone.focus) };
    }
    // An empty phone passes the optional-field helper, but a courier order
    // can never ship without a way to reach the customer.
    if (!phone.value) {
      return {
        ok: false,
        message: 'Please choose a country and enter your phone number so we can arrange delivery.',
        focus: focusField(form.querySelector('input[name="customerPhone"]')),
      };
    }
    const shipping = {
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
    const missing = required.find(([key]) => !shipping[key]);
    if (missing) {
      return {
        ok: false,
        message: 'Please complete the delivery address so we know where to send your order.',
        focus: focusField(form.querySelector(missing[1])),
      };
    }
    return {
      ok: true,
      customer: {
        name: String(form.querySelector('input[name="customerName"]')?.value || '').trim(),
        email: String(form.querySelector('input[name="customerEmail"]')?.value || '').trim(),
        phone: phone.value,
      },
      shipping,
    };
  }

  // One placement path for the two no-provider payment methods: cash on
  // delivery (Morocco only) and bank transfer (everywhere).
  async function confirmCheckout(event, paymentMethod) {
    event.preventDefault();
    if (!cart.getItems().length) {
      showToast?.('Your cart is empty');
      resetCheckout();
      return;
    }
    // Reachable both from the form's submit (cash on delivery) and from the
    // bank-transfer button, so always resolve the details form itself.
    const form = event.target instanceof HTMLFormElement
      ? event.target
      : event.target.closest?.('.checkout-details-form') ?? query('.checkout-details-form');
    const details = validateDetails(form);
    if (!details.ok) {
      setStatus(details.message);
      details.focus?.();
      return;
    }
    // The pay-on-delivery button is disabled outside Morocco and Western
    // Sahara, but Enter in a field could still submit the form.
    if (paymentMethod === 'cod' && !COD_COUNTRIES.has(details.shipping.country)) {
      setStatus('Oops — cash on delivery is only available in Morocco and Western Sahara. You can either pay by bank transfer or through WhatsApp.');
      return;
    }
    const submitCod = query('.checkout-confirm-cod');
    const submitTransfer = query('.checkout-confirm-transfer');
    const codEligible = COD_COUNTRIES.has(details.shipping.country);
    const generationAtStart = generation;
    if (submitCod) submitCod.disabled = true;
    if (submitTransfer) submitTransfer.disabled = true;
    setStatus('Placing your order…');
    try {
      const response = await fetch('/api/payments/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: details.customer,
          shipping: details.shipping,
          items: cart.getItems().map((item) => ({
            productId: item.productId,
            option: item.option,
            quantity: item.quantity,
          })),
          paymentMethod,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.error === 'try_again_later') throw new Error('Too many checkout attempts. Please wait a few minutes and try again.');
        if (body.error === 'cod_not_available') throw new Error('Oops — cash on delivery is only available in Morocco. You can either pay by bank transfer or through WhatsApp.');
        if (body.error === 'invalid_cart' || body.error === 'invalid_checkout') throw new Error('Please check your cart and contact details, then try again.');
        throw new Error('We could not record your order. Please try again or contact us for help.');
      }
      if (generationAtStart !== generation) return;
      if (body.mode !== paymentMethod || typeof body.orderReference !== 'string') {
        throw new Error('The order response was incomplete. Please try again.');
      }
      placedOrder = body;
      placedDetails = details;
      for (const item of cart.getItems()) cart.removeItem(item.key);
      updateCartCount?.();
      renderCartItems?.();
      form.hidden = true;
      const second = details.shipping.line2 ? `, ${details.shipping.line2}` : '';
      const message = query('[data-checkout-order-message]');
      const summary = query('[data-checkout-order-summary]');
      const total = formatCurrency(body.amountMinor / 100);
      if (message) {
        message.textContent = body.mode === 'bank_transfer'
          ? `Thank you for your order! Ref ${body.orderReference}. Please pay ${total} by bank transfer; we will send you our bank details right away (WhatsApp or email).`
          : `Thank you for your order! Ref ${body.orderReference}. You pay ${total} in cash when it is delivered.`;
      }
      if (summary) {
        summary.textContent = `Order for ${details.customer.name} — delivering to: ${details.shipping.line1}${second}, ${details.shipping.city} ${details.shipping.postalCode}. We will contact you to confirm.`;
      }
      const orderStage = query('.checkout-order-stage');
      if (orderStage) orderStage.hidden = false;
      const back = query('.checkout-back');
      if (back) back.textContent = 'Return to cart';
      query('.checkout-whatsapp-send')?.focus();
      setStatus('');
      // Signed-in customers keep the address for their next visit.
      const codSaveBox = query('[data-checkout-save-cod-address]');
      const codSaveCheckbox = codSaveBox?.querySelector('input[name="saveCodAddressToAccount"]');
      if (profile && codSaveCheckbox?.checked) {
        void persistAddressToAccount({
          line1: details.shipping.line1,
          line2: details.shipping.line2,
          city: details.shipping.city,
          postalCode: details.shipping.postalCode,
          country: details.shipping.country,
        });
      }
    } catch (error) {
      if (generationAtStart !== generation) return;
      if (submitCod) submitCod.disabled = !codEligible;
      if (submitTransfer) submitTransfer.disabled = false;
      setStatus(safeErrorMessage(error?.message));
    }
  }

  async function startCardPayment() {
    if (!cart.getItems().length) {
      showToast?.('Your cart is empty');
      resetCheckout();
      return;
    }
    const form = query('.checkout-details-form');
    const details = validateDetails(form);
    if (!details.ok) {
      setStatus(details.message);
      details.focus?.();
      return;
    }
    const submit = query('.checkout-confirm-cod');
    const paymentStage = query('.checkout-payment-stage');
    const generationAtStart = generation;
    if (submit) submit.disabled = true;
    setStatus('Preparing a secure card payment…');
    try {
      const response = await fetch('/api/payments/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: details.customer,
          // The delivery address is required in the form now, so card orders
          // are created complete and skip the post-payment delivery step.
          shipping: details.shipping,
          items: cart.getItems().map((item) => ({
            productId: item.productId,
            option: item.option,
            quantity: item.quantity,
          })),
          paymentMethod: 'card',
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.error === 'payments_not_configured') {
          throw new Error('Card payments are not configured yet. Please contact us to place your order.');
        }
        if (body.error === 'try_again_later') throw new Error('Too many checkout attempts. Please wait a few minutes and try again.');
        if (body.error === 'invalid_cart' || body.error === 'invalid_checkout') throw new Error('Please check your cart and contact details, then try again.');
        throw new Error('We could not start the payment. Please try again or contact us for help.');
      }
      if (generationAtStart !== generation) return;
      if ((body.mode !== 'sandbox' && body.mode !== 'live')
        || typeof body.token !== 'string' || typeof body.publicKey !== 'string') {
        throw new Error('The payment response was incomplete. Please try again.');
      }
      shippingCaptured = Boolean(details.shipping);
      checkoutSession = {
        ...body,
        customer: details.customer,
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

  function whatsappOrderText(details) {
    const items = cart.getItems();
    const lines = items
      .map((item) => `• ${item.productName} (${item.option}) × ${item.quantity} — ${formatCurrency(item.price * item.quantity)}`)
      .join('\n');
    let message = `Hello SilkItElegantly, I'd like to order:\n${lines}\n\nTotal: ${formatCurrency(cart.getTotal())}`;
    if (details) {
      const second = details.shipping.line2 ? `, ${details.shipping.line2}` : '';
      message += `\n\nName: ${details.customer.name}\nPhone: ${details.customer.phone}\nAddress: ${details.shipping.line1}${second}, ${details.shipping.city} ${details.shipping.postalCode}, ${details.shipping.country}`;
    }
    return message;
  }

  function openWhatsApp(message) {
    window.open(`https://wa.me/${WHATSAPP_ORDER_NUMBER}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  }

  // The in-panel button: the details form must be complete first.
  function checkoutByWhatsApp() {
    const items = cart.getItems();
    if (!items.length) {
      showToast?.('Your cart is empty');
      return;
    }
    const details = validateDetails(query('.checkout-details-form'));
    if (!details.ok) {
      setStatus(details.message);
      details.focus?.();
      return;
    }
    openWhatsApp(whatsappOrderText(details));
  }

  // Confirmation-step button: replays the order that was already recorded.
  function sendPlacedOrderOnWhatsApp() {
    if (!placedOrder || !placedDetails) {
      showToast?.('Your order details are not available right now');
      return;
    }
    const method = placedOrder.mode === 'bank_transfer' ? 'bank transfer' : 'cash on delivery';
    const shipping = placedDetails.shipping;
    const message = `Hello SilkItElegantly, I just placed order ${placedOrder.orderReference} (${method}):\n\nName: ${placedDetails.customer.name}\nPhone: ${placedDetails.customer.phone}\nAddress: ${shipping.line1}${shipping.line2 ? `, ${shipping.line2}` : ''}, ${shipping.city} ${shipping.postalCode}, ${shipping.country}\nTotal: ${formatCurrency(placedOrder.amountMinor / 100)}`;
    openWhatsApp(message);
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
      profile = {
        ...profile,
        addressLine1: values.line1,
        addressLine2: values.line2,
        city: values.city,
        postalCode: values.postalCode,
        country: values.country,
      };
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
        if (phone.focus) phone.focus.focus();
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
      // The cart footer's WhatsApp line now funnels through the checkout form
      // so the required details are collected in one place.
      openCheckout();
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
    if (event.target.closest('.checkout-confirm-transfer')) {
      void confirmCheckout(event, 'bank_transfer');
      return;
    }
    if (event.target.closest('.checkout-whatsapp-order')) {
      checkoutByWhatsApp();
      return;
    }
    if (event.target.closest('.checkout-whatsapp-send')) {
      sendPlacedOrderOnWhatsApp();
      return;
    }
    if (event.target.closest('[data-checkout-identity-pen]')) {
      const pen = event.target.closest('[data-checkout-identity-pen]');
      pen.setAttribute('aria-expanded', 'true');
      revealIdentityFields();
      return;
    }
    if (event.target.closest('[data-checkout-address-pen]')) {
      const pen = event.target.closest('[data-checkout-address-pen]');
      pen.setAttribute('aria-expanded', 'true');
      revealAddressFields();
      return;
    }
    const modal = query('#cart-modal');
    if (event.target.closest('.close-cart') || (modal && event.target === modal)) resetCheckout();
  });

  document.addEventListener('submit', (event) => {
    if (event.target.matches('.checkout-details-form')) void confirmCheckout(event, 'cod');
    else if (event.target.matches('.checkout-shipping-form')) void saveShippingDetails(event);
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('.checkout-details-form select[name="shippingCountry"]')) updateCodAvailability();
  });

  return resetCheckout;
}
