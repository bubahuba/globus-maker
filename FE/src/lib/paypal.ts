/** Public PayPal Checkout settings (amount/currency also enforced server-side). */

export interface PaypalPublicConfig {
	configured: boolean;
	mode: 'sandbox' | 'live';
	clientId: string | null;
	currency: string;
	amount: string;
	diameterCm?: number;
	pricing?: {
		minCm: number;
		maxCm: number;
		minEuro: number;
		maxEuro: number;
	};
}

export function formatPaypalAmountLabel(amount: string, currency: string): string {
	const value = amount.replace(/\.00$/, '');
	if (currency.toUpperCase() === 'EUR') return `€${value}`;
	if (currency.toUpperCase() === 'USD') return `$${value}`;
	return `${value} ${currency}`;
}

export async function fetchPaypalConfig(diameterCm?: number): Promise<PaypalPublicConfig> {
	const params = new URLSearchParams();
	if (diameterCm != null && Number.isFinite(diameterCm)) {
		params.set('diameterCm', String(diameterCm));
	}
	const qs = params.toString();
	const response = await fetch(`/api/paypal/config${qs ? `?${qs}` : ''}`);
	if (!response.ok) {
		throw new Error('Could not load PayPal config');
	}
	return (await response.json()) as PaypalPublicConfig;
}

export async function createPaypalOrder(
	jobId: string,
	format: 'zip' | 'pdf' = 'zip'
): Promise<{ id: string; alreadyPaid?: boolean }> {
	const response = await fetch('/api/paypal/orders', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jobId, format })
	});
	const body = (await response.json().catch(() => null)) as {
		id?: string;
		alreadyPaid?: boolean;
		error?: string;
	} | null;
	if (!response.ok) {
		throw new Error(body?.error || `Create order failed (${response.status})`);
	}
	if (!body?.id) throw new Error('Create order returned no id');
	return { id: body.id, alreadyPaid: body.alreadyPaid };
}

export async function capturePaypalOrder(
	orderId: string,
	jobId: string
): Promise<{ ok: boolean; paid: boolean }> {
	const response = await fetch(`/api/paypal/orders/${encodeURIComponent(orderId)}/capture`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jobId })
	});
	const body = (await response.json().catch(() => null)) as {
		ok?: boolean;
		paid?: boolean;
		error?: string;
	} | null;
	if (!response.ok) {
		throw new Error(body?.error || `Capture failed (${response.status})`);
	}
	return { ok: body?.ok === true, paid: body?.paid === true };
}

let sdkLoading: Promise<void> | null = null;
let loadedClientKey: string | null = null;

/** Load PayPal JS SDK once per client-id + currency. */
export function loadPaypalSdk(clientId: string, currency: string): Promise<void> {
	const key = `${clientId}:${currency}`;
	if (typeof window !== 'undefined' && window.paypal && loadedClientKey === key) {
		return Promise.resolve();
	}
	if (sdkLoading && loadedClientKey === key) return sdkLoading;

	loadedClientKey = key;
	sdkLoading = new Promise<void>((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>('script[data-paypal-sdk]');
		if (existing && window.paypal) {
			resolve();
			return;
		}
		existing?.remove();

		const script = document.createElement('script');
		script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
		script.async = true;
		script.dataset.paypalSdk = '1';
		script.onload = () => resolve();
		script.onerror = () => {
			sdkLoading = null;
			loadedClientKey = null;
			reject(new Error('Failed to load PayPal SDK'));
		};
		document.head.appendChild(script);
	});
	return sdkLoading;
}

export interface PaypalButtonsActions {
	close: () => Promise<void>;
}

declare global {
	interface Window {
		paypal?: {
			Buttons: (config: {
				style?: Record<string, string>;
				createOrder: () => Promise<string>;
				onApprove: (data: { orderID: string }) => Promise<void>;
				onError?: (err: Error) => void;
				onCancel?: () => void;
			}) => {
				render: (target: string | HTMLElement) => Promise<void>;
				close: () => Promise<void>;
			};
		};
	}
}
