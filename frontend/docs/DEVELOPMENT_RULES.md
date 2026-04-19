# UI Development Rules

## 1. Form Guidelines

### Labels
- Always use `FieldLabel` component for form labels
- Required fields MUST show a red asterisk `*` using `required` prop
- Label text should be in sentence case (e.g., "Institute Name" not "INSTITUTE NAME")

```tsx
// Required field
<FieldLabel label="Institute Name" required />
<InputText ... />

// Optional field
<FieldLabel label="Description" />
<InputTextarea ... />
```

### Input Groups
- Use PrimeReact `p-inputgroup` component for grouped inputs
- Suffix/prefix should use `p-inputgroup-addon`

```tsx
<div className="p-inputgroup">
    <InputText value={subdomain} ... />
    <span className="p-inputgroup-addon">.paathshalaos.com</span>
</div>
```

### Year Dropdowns
- Use dynamic year generation from 1900 to current year
- Use `Dropdown` with filter for better UX

```tsx
const generateYearOptions = () => {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let year = currentYear; year >= 1900; year--) {
        years.push({ label: year.toString(), value: year });
    }
    return years;
};

// Usage
<Dropdown
    value={formData.established_year}
    options={generateYearOptions()}
    placeholder="Select Year"
    filter
    filterPlaceholder="Search year"
/>
```

### Text Areas
- Use `InputTextarea` from primereact (NOT InputText with rows prop)

```tsx
<InputTextarea
    value={formData.description}
    onChange={(e) => handleChange('description', e.target.value)}
    rows={3}
    autoResize
/>
```

## 2. API Guidelines

### Using Common API Client

Import from the centralized lib:

```tsx
import { api, apiClient } from '@/lib/api';
```

### GET Request
```tsx
const { data } = await api.get('/tenants');
```

### POST Request
```tsx
const { data } = await api.post('/tenants', { name: 'School' });
```

### PUT Request
```tsx
const { data } = await api.put('/tenants/1', { name: 'Updated School' });
```

### PATCH Request
```tsx
const { data } = await api.patch('/tenants/1', { status: 1 });
```

### DELETE Request
```tsx
const { data } = await api.delete('/tenants/1');
```

### POST with Multipart Form Data (File Uploads)
```tsx
const formData = new FormData();
formData.append('file', fileObject);
formData.append('name', 'document');

const { data } = await api.postMultipart('/upload', formData);
```

### Using Endpoints Config

```tsx
import { getEndpoint, API_ENDPOINTS } from '@/config/endpoints';

// Simple endpoint
const endpoint = getEndpoint('TENANTS');

// With params
const endpoint = getEndpoint('ROLES_ASSIGN_PERMISSIONS', { id: 1 });
// Returns: '/roles/1/permissions'

const { data } = await api.get(endpoint);
```

### With Query Params
```tsx
const { data } = await api.get('/tenants', { params: { page: 1, per_page: 10 } });
// Returns: /api/tenants?page=1&per_page=10
```

## 3. Next.js App Router Guidelines

### usePathname
Always use `usePathname` hook (not `router.pathname`):

```tsx
import { useRouter, usePathname } from 'next/navigation';

export default function Component() {
    const router = useRouter();
    const pathname = usePathname();
    // use pathname, not router.pathname
}
```

### Client Components
Add 'use client' directive at top for components using hooks:

```tsx
'use client';

import { useState, useEffect } from 'react';
// ...
```

## 4. PrimeReact Best Practices

### DataTable Selection
Always include `selectionMode`:

```tsx
<DataTable
    selection={selectedItems}
    onSelectionChange={(e) => setSelectedItems(e.value)}
    selectionMode="multiple"  // Required for multiple selection
>
```

### Dialog Usage
Always include modal and footer:

```tsx
<Dialog
    visible={showDialog}
    onHide={() => setShowDialog(false)}
    style={{ width: '350px' }}
    modal
    footer={...}
>
    Content here
</Dialog>
```

## 5. Validation Patterns

### Required Field Validation
```tsx
const validateStep = (step: number): boolean => {
    if (step === 0) {
        if (!formData.name || !formData.email) return false;
        return true;
    }
    return true;
};
```

### Email Validation
```tsx
const isValidEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};
```

### Real-time Availability Check (Debounced)
```tsx
const timeoutRef = useRef<NodeJS.Timeout | null>(null);

const handleChange = (field: string, value: any) => {
    // ... other logic

    if (field === 'subdomain') {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        if (value && value.length >= 3) {
            timeoutRef.current = setTimeout(() => checkAvailability(value), 500);
        }
    }
};
```

## 6. Theme Switching

### Using useTheme Hook
```tsx
import { useTheme } from '@/hooks/useTheme';

export default function Component() {
    const { themeMode, setThemeMode, mounted } = useTheme();

    // Use mounted to prevent hydration mismatch
    if (!mounted) return null;

    const isDark = themeMode === 'dark';
    // ...
}
```

### Toggle Theme
```tsx
const toggleTheme = () => {
    setThemeMode(themeMode === 'dark' ? 'light' : 'dark');
};
```

## 7. Error Handling

### try-catch with Types
```tsx
try {
    const response = await api.get('/tenants');
    if (response.success) {
        setData(response.data);
    } else {
        setError(response.message || 'Failed to fetch');
    }
} catch (error) {
    console.error('Error:', error);
    setError('An error occurred');
}
```

### Using any Type for Dynamic Responses
```tsx
const res: any = await api.get('/endpoint');
```

## 8. Loading States

```tsx
const [loading, setLoading] = useState(false);

if (loading) {
    return <Spinner />;
}

// Or inline loading
<Button label="Submit" loading={loading} />
```