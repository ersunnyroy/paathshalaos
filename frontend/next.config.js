/** @type {import('next').NextConfig} */
const nextConfig = {
    transpilePackages: ['primereact', 'primeicons'],
    async rewrites() {
        return [
            {
                source: '/api/:path*',
                destination: 'http://127.0.0.1:8000/api/:path*',
            },
        ];
    },
    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    {
                        key: 'X-Tenant-ID',
                        value: ':request.headers.x-tenant-id',
                    },
                ],
            },
        ];
    },
};

module.exports = nextConfig;