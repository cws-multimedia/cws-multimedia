let currentService = '';
let currentPrice = 0;

function openOrderModal(serviceName, price) {
  currentService = serviceName;
  currentPrice = price;

  document.getElementById('modalServiceTitle').innerText = serviceName;
  document.getElementById('custAmount').value = price;
  document.getElementById('paymentStatus').innerText = '';
  document.getElementById('orderModal').classList.add('active');
  handlePaymentMethodChange();
}

function closeOrderModal() {
  document.getElementById('orderModal').classList.remove('active');
}

function handlePaymentMethodChange() {
  const method = document.getElementById('paymentMethod').value;
  const phoneGroup = document.getElementById('phoneGroup');
  const phoneInput = document.getElementById('custPhone');

  if (method === 'ecocash' || method === 'innbucks') {
    phoneGroup.style.display = 'block';
    phoneInput.required = true;
  } else {
    phoneGroup.style.display = 'none';
    phoneInput.required = false;
  }
}

document.getElementById('paynowForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const payBtn = document.getElementById('payBtn');
  const statusMsg = document.getElementById('paymentStatus');

  const payload = {
    serviceName: currentService,
    amount: currentPrice,
    name: document.getElementById('custName').value,
    email: document.getElementById('custEmail').value,
    paymentMethod: document.getElementById('paymentMethod').value,
    phone: document.getElementById('custPhone').value,
  };

  payBtn.disabled = true;
  payBtn.innerText = 'Processing...';
  statusMsg.style.color = '#a1a1aa';
  statusMsg.innerText = 'Connecting to Paynow gateway...';

  try {
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (data.success) {
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        statusMsg.style.color = '#10b981';
        statusMsg.innerText = data.instructions || 'Transaction initiated. Follow prompt on your mobile screen to approve payment.';
      }
    } else {
      statusMsg.style.color = '#ef4444';
      statusMsg.innerText = data.error || 'Payment failed. Please try again.';
    }
  } catch (err) {
    statusMsg.style.color = '#ef4444';
    statusMsg.innerText = 'Server error. Please verify network connection.';
  } finally {
    payBtn.disabled = false;
    payBtn.innerText = 'Pay via Paynow';
  }
});