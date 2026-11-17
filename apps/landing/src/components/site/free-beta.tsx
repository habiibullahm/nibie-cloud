"use client"

import { Button } from "@/components/ui/button"
import { betaAccessHref, SITE } from "@/lib/site"
import { waitlistUrl } from "@/lib/waitlist"
import { useBetaSlots } from "@/lib/use-beta-slots"

/** Badge text for the hero in free beta mode: a live count when known, a static label otherwise. */
export function FreeBetaBadgeText() {
  const slots = useBetaSlots()
  if (slots && slots.remaining === 0) return <>Beta gratis · slot penuh</>
  if (slots) return <>Beta gratis · sisa {slots.remaining} slot</>
  return <>Beta gratis · slot terbatas</>
}

/** Main call to action in free beta mode: register while slots remain, join the waiting list when they are gone. */
export function FreeBetaCta() {
  const slots = useBetaSlots()
  const full = slots !== null && slots.remaining === 0
  // With the API configured the waiting list is a form on this page; without it the old access-request email remains.
  const waitlistHref = waitlistUrl() ? "#daftar-tunggu" : betaAccessHref("Daftar tunggu beta Nibie Cloud")
  return (
    <>
      <Button asChild>
        {full ? (
          <a href={waitlistHref}>Masuk daftar tunggu</a>
        ) : (
          <a href={SITE.registerUrl}>Daftar beta gratis</a>
        )}
      </Button>
      {slots ? (
        <p className="basis-full text-[0.8125rem] text-muted-foreground" aria-live="polite">
          {full
            ? `Semua ${slots.total} slot gratis sudah terpakai. Masuk daftar tunggu dan kami kabari lewat email.`
            : `Sisa ${slots.remaining} dari ${slots.total} slot gratis, siapa cepat dia dapat.`}
        </p>
      ) : null}
    </>
  )
}
