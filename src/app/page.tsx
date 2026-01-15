'use client'

import { Button } from '@/components/ui/button'
import React from 'react'

const main = () => {
  const handleClick = async () => {
    try {
      const response = await fetch('/api/trigger-render', {
        method: 'POST',
      });
      
      if (response.ok) {
        console.log('Inngest function triggered successfully');
      } else {
        console.error('Failed to trigger Inngest function');
      }
    } catch (error) {
      console.error('Error triggering Inngest function:', error);
    }
  };

  return (
    <div>
      <Button onClick={handleClick}>upload file</Button>
    </div>
  )
}

export default main