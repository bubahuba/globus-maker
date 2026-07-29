<script lang="ts">
	type LightboxImage = {
		slug: string;
		alt: string;
		caption: string;
	};

	interface Props {
		images: readonly LightboxImage[];
		index: number | null;
		onClose: () => void;
		onNavigate: (index: number) => void;
	}

	let { images, index, onClose, onNavigate }: Props = $props();

	const uid = $props.id();
	const captionId = `${uid}-caption`;

	const open = $derived(index !== null);
	const current = $derived(index !== null ? images[index] : null);
	const showNav = $derived(images.length > 1);

	function fullSrc(slug: string) {
		return `/about/${slug}.png`;
	}

	function goPrev() {
		if (index === null || images.length === 0) return;
		onNavigate((index - 1 + images.length) % images.length);
	}

	function goNext() {
		if (index === null || images.length === 0) return;
		onNavigate((index + 1) % images.length);
	}

	function onBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onClose();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		} else if (event.key === 'ArrowLeft' && showNav) {
			event.preventDefault();
			goPrev();
		} else if (event.key === 'ArrowRight' && showNav) {
			event.preventDefault();
			goNext();
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
				'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open && current}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/80 p-4 sm:p-6"
		role="presentation"
		onclick={onBackdropClick}
	>
		<div
			{@attach dialogPanel}
			class="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col"
			role="dialog"
			aria-modal="true"
			aria-labelledby={captionId}
			tabindex="-1"
		>
			<button
				type="button"
				onclick={onClose}
				data-autofocus
				class="absolute top-0 right-0 z-10 -mt-1 -mr-1 rounded-full bg-stone-900/70 p-2 text-stone-100 transition hover:bg-amber-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 sm:top-2 sm:right-2"
				aria-label="Close"
			>
				<svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path
						d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"
					/>
				</svg>
			</button>

			{#if showNav}
				<button
					type="button"
					onclick={goPrev}
					class="absolute top-1/2 left-0 z-10 flex -translate-y-1/2 rounded-full bg-stone-900/70 p-2 text-stone-100 transition hover:bg-amber-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 sm:p-2.5 sm:-ml-1 lg:-ml-3"
					aria-label="Previous image"
				>
					<svg class="h-6 w-6" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
						<path
							fill-rule="evenodd"
							d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z"
							clip-rule="evenodd"
						/>
					</svg>
				</button>
				<button
					type="button"
					onclick={goNext}
					class="absolute top-1/2 right-0 z-10 flex -translate-y-1/2 rounded-full bg-stone-900/70 p-2 text-stone-100 transition hover:bg-amber-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 sm:p-2.5 sm:-mr-1 lg:-mr-3"
					aria-label="Next image"
				>
					<svg class="h-6 w-6" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
						<path
							fill-rule="evenodd"
							d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
							clip-rule="evenodd"
						/>
					</svg>
				</button>
			{/if}

			<figure class="flex min-h-0 flex-1 flex-col items-center justify-center">
				<img
					src={fullSrc(current.slug)}
					alt={current.alt}
					class="max-h-[min(80dvh,calc(100dvh-8rem))] w-auto max-w-full rounded-lg object-contain shadow-2xl"
				/>
				<figcaption
					id={captionId}
					class="mt-4 max-w-2xl px-2 text-center text-sm text-stone-200 sm:text-base"
				>
					{current.caption}
				</figcaption>
			</figure>
		</div>
	</div>
{/if}
