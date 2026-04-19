'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from 'primereact/button';
import Link from 'next/link';

export default function NotFoundPage() {
    const router = useRouter();

    return (
        <div className="flex align-items-center justify-content-center min-h-screen surface-50 p-4">
            <div className="surface-card p-5 shadow-2 border-round-xl text-center max-w-30rem">
                <div className="mb-4">
                    <i className="pi pi-exclamation-triangle text-6xl text-orange-500" />
                </div>
                <h1 className="text-4xl font-bold text-900 mb-3">School Not Found</h1>
                <p className="text-600 mb-4" style={{ fontSize: '1.1rem' }}>
                    We could not find a school with this web address. The school may have moved or the web address might be incorrect.
                </p>
                <p className="text-500 text-sm mb-4">
                    Looking for a different school? Try searching or go to our main platform.
                </p>

                <div className="flex gap-2 justify-content-center">
                    <Button
                        label="Go to PaathshalaOS"
                        icon="pi pi-home"
                        onClick={() => router.push('/home')}
                    />
                    <Button
                        label="Try Again"
                        icon="pi pi-refresh"
                        className="p-button-outlined"
                        onClick={() => window.location.reload()}
                    />
                </div>
            </div>
        </div>
    );
}