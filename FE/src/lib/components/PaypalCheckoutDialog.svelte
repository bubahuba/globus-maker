<script lang="ts">
	import { trackModeEvent, type AnalyticsParams } from '@lib/analytics';
	import {
		capturePaypalOrder,
		createPaypalOrder,
		fetchPaypalConfig,
		formatPaypalAmountLabel,
		loadPaypalSdk,
		type PaypalPublicConfig
	} from '@lib/paypal';
	import { globeDownloadPriceEuro } from '@shared/globe-pricing';

	interface Props {
		open?: boolean;
		jobId: string;
		filename?: string | null;
		/** Job globe diameter — drives checkout price (€2–€6). */
		diameterCm?: number;
		/** Stripe count for analytics. */
		stripeCount?: number;
		/** Place label for analytics. */
		placeName?: string | null;
		/** Selected globe download packaging (affects PayPal line item name). */
		downloadFormat?: 'zip' | 'pdf';
		/** Full globe zip after successful capture. */
		ondownload: () => void | Promise<void>;
		/** Map SVG only — does not unlock or purge zip. */
		onfreeDownload: () => void | Promise<void>;
		ondismiss?: () => void;
	}

	let {
		open = $bindable(false),
		jobId,
		filename = null,
		diameterCm,
		stripeCount,
		placeName = null,
		downloadFormat = 'zip',
		ondownload,
		onfreeDownload,
		ondismiss
	}: Props = $props();

	let config = $state<PaypalPublicConfig | null>(null);
	let loadError = $state<string | null>(null);
	let payError = $state<string | null>(null);
	let busy = $state<'sdk' | 'pay' | 'paid' | 'free' | null>(null);
	let shareCopied = $state(false);
	let shareCopyTimer: ReturnType<typeof setTimeout> | undefined;

	const titleId = 'paypal-checkout-dialog-title';
	const descId = 'paypal-checkout-dialog-desc';

	/** Client preview from diameter; prefer server amount once config loads. */
	const previewAmount = $derived(
		config?.amount ??
			(diameterCm != null && Number.isFinite(diameterCm)
				? globeDownloadPriceEuro(diameterCm)
				: null)
	);

	const amountCurrency = $derived(config?.currency ?? 'EUR');

	const amountLabel = $derived(
		previewAmount ? formatPaypalAmountLabel(previewAmount, amountCurrency) : '…'
	);

	const diameterLabel = $derived(
		diameterCm != null && Number.isFinite(diameterCm)
			? `${Number(diameterCm).toFixed(Number(diameterCm) % 1 === 0 ? 0 : 1)} cm`
			: null
	);

	const zipLabel = $derived(filename ?? (downloadFormat === 'pdf' ? 'pdf' : 'zip'));

	const globeAnalyticsParams = $derived.by((): AnalyticsParams => {
		const params: AnalyticsParams = {
			city: placeName,
			format: downloadFormat
		};
		if (diameterCm != null && Number.isFinite(diameterCm)) {
			params.diameterCm = Number(diameterCm);
		}
		if (stripeCount != null && Number.isFinite(stripeCount)) {
			params.stripes = Math.round(Number(stripeCount));
		}
		return params;
	});

	function close() {
		if (!open) return;
		open = false;
		ondismiss?.();
	}

	async function confirmFreeDownload() {
		if (busy) return;
		busy = 'free';
		payError = null;
		try {
			await onfreeDownload();
			open = false;
		} catch (err) {
			payError = err instanceof Error ? err.message : 'Download failed';
		} finally {
			busy = null;
		}
	}

	async function shareJobUrl() {
		if (busy) return;
		payError = null;
		try {
			await navigator.clipboard.writeText(window.location.href);
			trackModeEvent('share', 'globe', globeAnalyticsParams);
			shareCopied = true;
			clearTimeout(shareCopyTimer);
			shareCopyTimer = setTimeout(() => {
				shareCopied = false;
			}, 2000);
		} catch {
			payError = 'Could not copy link to clipboard';
		}
	}

	function trackPurchase() {
		const amountNum = previewAmount != null ? Number(previewAmount) : NaN;
		trackModeEvent('purchase', 'globe', {
			...globeAnalyticsParams,
			value: Number.isFinite(amountNum) ? amountNum : previewAmount,
			currency: amountCurrency,
			paypalMode: config?.mode
		});
	}

	async function afterPaid() {
		busy = 'paid';
		try {
			await ondownload();
			open = false;
		} catch (err) {
			payError = err instanceof Error ? err.message : 'Download failed after payment';
		} finally {
			busy = null;
		}
	}

	function onBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget && busy == null) close();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape' && busy == null) {
			event.preventDefault();
			close();
		}
	}

	function dialogPanel(node: HTMLElement) {
		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		const focusTarget =
			node.querySelector<HTMLElement>('[data-autofocus]') ??
			node.querySelector<HTMLElement>('button:not([disabled])');
		focusTarget?.focus();

		function onKeydown(event: KeyboardEvent) {
			if (event.key !== 'Tab') return;
			const focusable = node.querySelectorAll<HTMLElement>(
				'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]), iframe'
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement as HTMLElement | null;
			if (event.shiftKey) {
				if (active === first || !node.contains(active)) {
					event.preventDefault();
					last.focus();
				}
			} else if (active === last) {
				event.preventDefault();
				first.focus();
			}
		}

		node.addEventListener('keydown', onKeydown);
		return () => {
			node.removeEventListener('keydown', onKeydown);
			document.body.style.overflow = prevOverflow;
			previouslyFocused?.focus?.();
		};
	}

	/** Mount PayPal Buttons into the host element while the dialog is open. */
	function paypalButtonsHost(node: HTMLElement) {
		let cancelled = false;
		let buttons: { close: () => Promise<void> } | null = null;

		busy = 'sdk';
		loadError = null;
		payError = null;
		config = null;
		node.replaceChildren();

		void (async () => {
			try {
				const next = await fetchPaypalConfig(diameterCm);
				if (cancelled) return;
				config = next;
				if (!next.configured || !next.clientId) {
					loadError = 'PayPal is not configured on the server.';
					busy = null;
					return;
				}

				await loadPaypalSdk(next.clientId, next.currency);
				if (cancelled || !window.paypal) return;

				const instance = window.paypal.Buttons({
					style: {
						layout: 'vertical',
						color: 'gold',
						shape: 'rect',
						label: 'pay'
					},
					createOrder: async () => {
						payError = null;
						const order = await createPaypalOrder(jobId, downloadFormat);
						if (order.alreadyPaid) {
							await afterPaid();
							return Promise.reject(new Error('ALREADY_PAID'));
						}
						return order.id;
					},
					onApprove: async (data) => {
						busy = 'pay';
						payError = null;
						try {
							const result = await capturePaypalOrder(data.orderID, jobId);
							if (!result.paid) throw new Error('Payment was not completed');
							trackPurchase();
							await afterPaid();
						} catch (err) {
							payError = err instanceof Error ? err.message : 'Payment failed';
							busy = null;
						}
					},
					onError: (err) => {
						if (String(err?.message ?? '') === 'ALREADY_PAID') return;
						payError = err?.message || 'PayPal error';
						busy = null;
					},
					onCancel: () => {
						busy = null;
					}
				});

				buttons = instance;
				await instance.render(node);
				if (!cancelled) busy = null;
			} catch (err) {
				if (cancelled) return;
				loadError = err instanceof Error ? err.message : 'Could not start PayPal';
				busy = null;
			}
		})();

		return () => {
			cancelled = true;
			void buttons?.close?.();
			node.replaceChildren();
		};
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-4 sm:items-center"
		role="presentation"
		onclick={onBackdropClick}
	>
		<div
			{@attach dialogPanel}
			class="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-panel shadow-xl ring-1 ring-line"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			aria-describedby={descId}
		>
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6">
				<h2 id={titleId} class="text-lg font-semibold text-ink">
					Download globe stripes
				</h2>
				<p id={descId} class="mt-2 text-sm leading-relaxed text-ink-secondary">
					Making globe strips takes a bit more work than a flat map. Pay once to download
					everything — the square map, pole caps, printable strips, and a short README.
					{#if filename}
						<span class="mt-1 block font-mono text-xs text-ink-subtle">{filename}</span>
					{/if}
					{#if config?.mode === 'sandbox'}
						<span class="mt-1 block text-xs text-accent-ink">Sandbox mode — no real charge.</span>
					{/if}
				</p>

				<div
					class="mt-4 rounded-xl bg-accent-soft px-4 py-3 ring-1 ring-accent-soft-strong"
					aria-live="polite"
				>
					<div class="flex items-baseline justify-between gap-3">
						<div>
							<p class="text-xs font-medium tracking-wide text-accent-ink/70 uppercase">
								Price for this globe
							</p>
							{#if diameterLabel}
								<p class="mt-0.5 text-sm text-ink-secondary">
									{diameterLabel} diameter · €2–€6 by size
								</p>
							{:else}
								<p class="mt-0.5 text-sm text-ink-secondary">€2 at 20 cm → €6 at 60 cm</p>
							{/if}
						</div>
						<p class="text-2xl font-semibold tabular-nums text-ink">{amountLabel}</p>
					</div>
				</div>

				<div class="mt-5 min-h-[48px]">
					{#if loadError}
						<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-100">
							{loadError}
						</p>
					{:else if busy === 'sdk'}
						<p class="text-sm text-ink-subtle">Loading PayPal…</p>
					{/if}
					<div {@attach paypalButtonsHost} class="w-full" data-autofocus></div>
					{#if busy === 'pay' || busy === 'paid'}
						<p class="mt-2 text-sm text-ink-secondary">
							{busy === 'paid' ? `Downloading ${zipLabel}…` : 'Confirming payment…'}
						</p>
					{/if}
				</div>

				{#if payError}
					<p class="mt-3 text-sm text-red-700">{payError}</p>
				{/if}

				<button
					type="button"
					onclick={shareJobUrl}
					disabled={busy != null}
					class="mt-4 w-full rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink-secondary transition hover:border-accent hover:bg-accent-soft hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
				>
					{shareCopied ? 'Link copied!' : 'Share job url'}
				</button>

				<button
					type="button"
					onclick={confirmFreeDownload}
					disabled={busy != null}
					class="mt-3 w-full rounded-lg px-3 py-2 text-sm text-ink-secondary underline decoration-line-strong underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
				>
					{busy === 'free' ? 'Downloading…' : 'Download map SVG without paying'}
				</button>

				<button
					type="button"
					onclick={close}
					disabled={busy === 'pay' || busy === 'paid'}
					class="mt-2 w-full rounded-lg px-3 py-1.5 text-xs text-ink-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-line-strong disabled:opacity-50"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
