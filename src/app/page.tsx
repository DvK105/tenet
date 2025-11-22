import { Button } from '@/components/ui/button'
import Link from 'next/link'
import React from 'react'

const page = () => {
  return (
    <div>
      <Button variant="link">
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    </div>
  )
}

export default page