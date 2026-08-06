<script lang="ts">
	import { page } from '$app/state';

	const links = [
		{ href: '/', label: 'Globe Maker App' },
		{ href: '/latest-planet', label: 'Latest planet' },
		{ href: '/about', label: 'About this app' }
	] as const;

	let menuOpen = $state(false);

	const pathname = $derived(page.url.pathname.replace(/\/$/, '') || '/');

	function isActive(href: string): boolean {
		const normalized = href.replace(/\/$/, '') || '/';
		return pathname === normalized;
	}

	function closeMenu() {
		menuOpen = false;
	}
</script>

<header
	class="sticky top-0 z-50 border-b border-line/80 bg-canvas/90 backdrop-blur-md"
>
	<div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
		<a
			href="/"
			class="inline-flex items-center gap-2.5 text-sm font-semibold tracking-wide text-ink transition hover:text-accent-ink"
			onclick={closeMenu}
		>
			<img
				src="/icon-192.png"
				alt=""
				width="32"
				height="32"
				class="h-8 w-8 rounded-lg shadow-sm ring-1 ring-line/80"
				decoding="async"
			/>
			<span>Globe Maker</span>
		</a>

		<nav class="hidden items-center gap-1 sm:flex" aria-label="Main">
			{#each links as link (link.href)}
				<a
					href={link.href}
					class="rounded-lg px-3 py-2 text-sm font-medium transition
						{isActive(link.href)
						? 'bg-accent-soft-strong text-accent-ink-strong'
						: 'text-ink-secondary hover:bg-panel-muted hover:text-ink'}"
					aria-current={isActive(link.href) ? 'page' : undefined}
				>
					{link.label}
				</a>
			{/each}
		</nav>

		<button
			type="button"
			class="inline-flex items-center justify-center rounded-lg p-2 text-ink-secondary transition hover:bg-panel-muted sm:hidden"
			aria-expanded={menuOpen}
			aria-controls="mobile-nav"
			aria-label={menuOpen ? 'Close menu' : 'Open menu'}
			onclick={() => (menuOpen = !menuOpen)}
		>
			{#if menuOpen}
				<svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path
						fill-rule="evenodd"
						d="M4.22 4.22a.75.75 0 011.06 0L10 8.94l4.72-4.72a.75.75 0 111.06 1.06L11.06 10l4.72 4.72a.75.75 0 11-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 11-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 010-1.06z"
						clip-rule="evenodd"
					/>
				</svg>
			{:else}
				<svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path
						fill-rule="evenodd"
						d="M2.75 5.25a.75.75 0 000 1.5h14.5a.75.75 0 000-1.5H2.75zm0 4a.75.75 0 000 1.5h14.5a.75.75 0 000-1.5H2.75zm0 4a.75.75 0 000 1.5h14.5a.75.75 0 000-1.5H2.75z"
						clip-rule="evenodd"
					/>
				</svg>
			{/if}
		</button>
	</div>

	{#if menuOpen}
		<nav
			id="mobile-nav"
			class="border-t border-line/80 bg-canvas px-4 py-3 sm:hidden"
			aria-label="Main mobile"
		>
			<ul class="flex flex-col gap-1">
				{#each links as link (link.href)}
					<li>
						<a
							href={link.href}
							class="block rounded-lg px-3 py-2.5 text-sm font-medium transition
								{isActive(link.href)
								? 'bg-accent-soft-strong text-accent-ink-strong'
								: 'text-ink-secondary hover:bg-panel-muted hover:text-ink'}"
							aria-current={isActive(link.href) ? 'page' : undefined}
							onclick={closeMenu}
						>
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	{/if}
</header>
