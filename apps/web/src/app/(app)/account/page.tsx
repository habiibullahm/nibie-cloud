"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { useMe } from "@/hooks/use-hermes"

export default function AccountPage() {
  const me = useMe()
  return (
    <div className="grid gap-8">
      <PageHeader title="Account" description="Your Hermes Cloud profile and sign-in." />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Accounts arrive with customer sign-in. These fields are read-only for now.</CardDescription>
          <CardAction>
            <PreviewNote what="Account" />
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="acc-name">Name</Label>
            <Input id="acc-name" value={me.data?.name ?? ""} readOnly />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="acc-email">Email</Label>
            <Input id="acc-email" type="email" value={me.data?.email ?? ""} readOnly />
          </div>
        </CardContent>
        <CardFooter className="border-t">
          <Button asChild variant="outline">
            <Link href="/sign-in">Sign out</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
