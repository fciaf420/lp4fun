// app/private/layout.tsx
import React from 'react';
import PrivateProviders from './PrivateProviders';

export default function PrivateLayout({children}: { children: React.ReactNode }) {
    return <PrivateProviders>{children}</PrivateProviders>;
}
