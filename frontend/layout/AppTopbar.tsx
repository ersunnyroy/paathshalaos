/* eslint-disable @next/next/no-img-element */

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PrimeReactContext } from 'primereact/api';
import { classNames } from 'primereact/utils';
import React, { forwardRef, useContext, useImperativeHandle, useRef } from 'react';
import { AppTopbarRef } from '@/types';
import { LayoutContext } from './context/layoutcontext';
import { authService, api } from '@/services/api';

const AppTopbar = forwardRef<AppTopbarRef>((props, ref) => {
    const { layoutConfig, layoutState, setLayoutConfig, onMenuToggle, showProfileSidebar } = useContext(LayoutContext);
    const { changeTheme } = useContext(PrimeReactContext);
    const router = useRouter();
    const menubuttonRef = useRef(null);
    const topbarmenuRef = useRef(null);
    const topbarmenubuttonRef = useRef(null);

    useImperativeHandle(ref, () => ({
        menubutton: menubuttonRef.current,
        topbarmenu: topbarmenuRef.current,
        topbarmenubutton: topbarmenubuttonRef.current,
    }));

    const handleLogout = async () => {
        try {
            await authService.logout();
        } catch (e) {
            console.error('Logout error:', e);
        } finally {
            api.removeToken();
            router.push('/auth/login');
        }
    };

    const toggleColorMode = () => {
        const goDark = layoutConfig.colorScheme === 'light';
        const newTheme = goDark ? 'lara-dark-teal' : 'lara-light-teal';
        const newScheme = goDark ? 'dark' : 'light';

        const apply = () => {
            setLayoutConfig((prev) => ({ ...prev, theme: newTheme, colorScheme: newScheme }));
            if (typeof window !== 'undefined') {
                localStorage.setItem('theme', newTheme);
            }
        };

        if (changeTheme) {
            changeTheme(layoutConfig.theme, newTheme, 'theme-css', apply);
        } else {
            const link = document.getElementById('theme-css') as HTMLLinkElement | null;
            if (link) {
                link.href = `/themes/${newTheme}/theme.css`;
            }
            apply();
        }
    };

    return (
        <div className="layout-topbar">
            <Link href="/main" className="layout-topbar-logo">
                <img
                    src={`/layout/images/logo-${layoutConfig.colorScheme !== 'light' ? 'white' : 'dark'}.svg`}
                    width="47.22px"
                    height={'35px'}
                    alt="PaathshalaOS"
                />
                <span>PaathshalaOS</span>
            </Link>

            <button ref={menubuttonRef} type="button" className="p-link layout-menu-button layout-topbar-button" onClick={onMenuToggle}>
                <i className="pi pi-bars" />
            </button>

            <button
                type="button"
                className="p-link layout-topbar-button"
                onClick={toggleColorMode}
                title={layoutConfig.colorScheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
                aria-label={layoutConfig.colorScheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
                <i className={layoutConfig.colorScheme === 'light' ? 'pi pi-moon' : 'pi pi-sun'} />
            </button>

            <button ref={topbarmenubuttonRef} type="button" className="p-link layout-topbar-menu-button layout-topbar-button" onClick={showProfileSidebar}>
                <i className="pi pi-ellipsis-v" />
            </button>

            <div ref={topbarmenuRef} className={classNames('layout-topbar-menu', { 'layout-topbar-menu-mobile-active': layoutState.profileSidebarVisible })}>
                <button type="button" className="p-link layout-topbar-button">
                    <i className="pi pi-calendar"></i>
                    <span>Calendar</span>
                </button>
                <Link href="/main" className="p-link layout-topbar-button">
                    <i className="pi pi-user"></i>
                    <span>Dashboard</span>
                </Link>
                <Link href="/main/documentation" className="p-link layout-topbar-button">
                    <i className="pi pi-cog"></i>
                    <span>Documentation</span>
                </Link>
                <button type="button" className="p-link layout-topbar-button" onClick={handleLogout}>
                    <i className="pi pi-sign-out"></i>
                    <span>Logout</span>
                </button>
            </div>
        </div>
    );
});

AppTopbar.displayName = 'AppTopbar';

export default AppTopbar;
