'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from 'primereact/button';

export default function HomePage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(false);
    }, []);

    if (loading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen surface-50">
                <i className="pi pi-spin pi-spinner text-4xl" />
            </div>
        );
    }

    return (
        <div className="min-h-screen surface-0">
            <div className="flex flex-column align-items-center justify-content-center py-8 px-4" style={{ minHeight: '80vh' }}>
                <div className="text-center mb-6">
                    <img
                        src="/logo.png"
                        alt="PaathshalaOS"
                        className="mb-4"
                        style={{ maxHeight: '80px' }}
                        onError={(e: any) => {
                            e.target.style.display = 'none';
                        }}
                    />
                    <h1 className="text-5xl font-bold text-900 mb-3">PaathshalaOS</h1>
                    <p className="text-xl text-600 mb-5" style={{ maxWidth: '600px' }}>
                        The complete school management platform for modern educational institutions.
                        Manage admissions, students, fees, examinations and more in one unified system.
                    </p>
                </div>

                <div className="flex gap-3">
                    <Button
                        label="Sign In"
                        icon="pi pi-sign-in"
                        size="large"
                        onClick={() => router.push('/auth/login')}
                    />
                    <Button
                        label="Admin Login"
                        icon="pi pi-user"
                        className="p-button-outlined"
                        size="large"
                        onClick={() => router.push('/auth/login')}
                    />
                </div>

                <div className="grid mt-8" style={{ maxWidth: '1000px' }}>
                    <div className="col-12 md:col-4">
                        <div className="surface-card p-4 border-round text-center h-full">
                            <i className="pi pi-users text-4xl text-primary mb-3" />
                            <h3 className="text-xl font-medium mb-2">Student Management</h3>
                            <p className="text-600">Complete student database with profiles, attendance, and performance tracking.</p>
                        </div>
                    </div>
                    <div className="col-12 md:col-4">
                        <div className="surface-card p-4 border-round text-center h-full">
                            <i className="pi pi-wallet text-4xl text-primary mb-3" />
                            <h3 className="text-xl font-medium mb-2">Fee Management</h3>
                            <p className="text-600">Online fee collection, invoices, and payment tracking.</p>
                        </div>
                    </div>
                    <div className="col-12 md:col-4">
                        <div className="surface-card p-4 border-round text-center h-full">
                            <i className="pi pi-book text-4xl text-primary mb-3" />
                            <h3 className="text-xl font-medium mb-2">Academic Results</h3>
                            <p className="text-600">Examinations, grading, and comprehensive result analysis.</p>
                        </div>
                    </div>
                </div>

                <div className="mt-8 text-center">
                    <p className="text-500 text-sm">
                        Trusted by 500+ educational institutions worldwide
                    </p>
                </div>
            </div>

            <footer className="surface-100 py-4 text-center">
                <span className="text-500 text-sm">
                    © {new Date().getFullYear()} PaathshalaOS. All rights reserved.
                </span>
            </footer>
        </div>
    );
}