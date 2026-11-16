<template>
  <section class="pt-10 sm:pt-16">
    <h1 class="text-4xl font-bold tracking-tight text-default sm:text-5xl">KrabiClaw Support</h1>
    <p class="mt-3 text-3xl font-semibold tracking-tight text-muted sm:text-4xl">How can we help you today?</p>

    <div class="mt-8 grid gap-4 md:grid-cols-2">
      <NuxtLink
        v-for="card in routeCards"
        :key="card.to"
        :to="card.to"
        class="group rounded-3xl border border-default bg-elevated/40 p-6 no-underline transition hover:border-muted hover:bg-elevated"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-lg font-semibold text-default">{{ card.title }}</p>
            <p class="mt-3 text-sm leading-relaxed text-muted">{{ card.description }}</p>
          </div>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            class="mt-1 size-5 shrink-0 text-muted transition group-hover:text-default"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M7 13 13 7M8 7h5v5" />
          </svg>
        </div>
      </NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { PUBLIC_SUPPORT_ROUTE_CARDS } from '~/utils/public-support'

/*
  The support page's empty state. It is a component rather than page markup
  because it renders in two places: inside the conversation while the transcript
  is still just the greeting, and as the server-rendered fallback for the
  client-only conversation — so the heading and the route links are in the HTML
  a crawler receives.
*/
const routeCards = PUBLIC_SUPPORT_ROUTE_CARDS
</script>
