/* eslint-disable @next/next/no-img-element */

import React from 'react';

const AppFooter = () => {
    const currentYear = new Date().getFullYear();

    return (
        <div className="layout-footer">
            <span className="font-medium">© PaathshalaOS {currentYear}</span>
        </div>
    );
};

export default AppFooter;
