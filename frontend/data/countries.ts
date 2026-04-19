export const INSTITUTE_TYPES = [
    { label: 'School', value: 'school' },
    { label: 'College', value: 'college' },
    { label: 'Coaching Center', value: 'coaching' },
    { label: 'University', value: 'university' },
    { label: 'Other', value: 'other' },
];

export const COUNTRIES = [
    { label: 'India', value: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', flag: '🇮🇳' },
    { label: 'United States', value: 'US', currency: 'USD', timezone: 'America/New_York', flag: '🇺🇸' },
    { label: 'United Kingdom', value: 'GB', currency: 'GBP', timezone: 'Europe/London', flag: '🇬🇧' },
    { label: 'Australia', value: 'AU', currency: 'AUD', timezone: 'Australia/Sydney', flag: '🇦🇺' },
    { label: 'Canada', value: 'CA', currency: 'CAD', timezone: 'America/Toronto', flag: '🇨🇦' },
    { label: 'UAE', value: 'AE', currency: 'AED', timezone: 'Asia/Dubai', flag: '🇦🇪' },
    { label: 'Saudi Arabia', value: 'SA', currency: 'SAR', timezone: 'Asia/Riyadh', flag: '🇸🇦' },
    { label: 'Singapore', value: 'SG', currency: 'SGD', timezone: 'Asia/Singapore', flag: '🇸🇬' },
    { label: 'Nepal', value: 'NP', currency: 'NPR', timezone: 'Asia/Kathmandu', flag: '🇳🇵' },
    { label: 'Bangladesh', value: 'BD', currency: 'BDT', timezone: 'Asia/Dhaka', flag: '🇧🇩' },
    { label: 'Sri Lanka', value: 'LK', currency: 'LKR', timezone: 'Asia/Colombo', flag: '🇱🇰' },
    { label: 'Pakistan', value: 'PK', currency: 'PKR', timezone: 'Asia/Karachi', flag: '🇵🇰' },
    { label: 'Other', value: 'OTHER', currency: 'USD', timezone: 'UTC', flag: '🌍' },
];

export const INDIAN_BOARDS = [
    { label: 'CBSE', value: 'cbse' },
    { label: 'ICSE', value: 'icse' },
    { label: 'State Board', value: 'state' },
    { label: 'IB', value: 'ib' },
    { label: 'Cambridge', value: 'cambridge' },
    { label: 'NIOS', value: 'nios' },
    { label: 'Other', value: 'other' },
];

export const MEDIUMS = [
    { label: 'English', value: 'english' },
    { label: 'Hindi', value: 'hindi' },
    { label: 'Bilingual (English + Hindi)', value: 'bilingual' },
    { label: 'Regional Language', value: 'regional' },
    { label: 'Other', value: 'other' },
];

export const INDIAN_STATES = [
    { label: 'Andhra Pradesh', value: 'AP' },
    { label: 'Arunachal Pradesh', value: 'AR' },
    { label: 'Assam', value: 'AS' },
    { label: 'Bihar', value: 'BR' },
    { label: 'Chhattisgarh', value: 'CG' },
    { label: 'Goa', value: 'GA' },
    { label: 'Gujarat', value: 'GJ' },
    { label: 'Haryana', value: 'HR' },
    { label: 'Himachal Pradesh', value: 'HP' },
    { label: 'Jharkhand', value: 'JH' },
    { label: 'Karnataka', value: 'KA' },
    { label: 'Kerala', value: 'KL' },
    { label: 'Madhya Pradesh', value: 'MP' },
    { label: 'Maharashtra', value: 'MH' },
    { label: 'Manipur', value: 'MN' },
    { label: 'Meghalaya', value: 'ML' },
    { label: 'Mizoram', value: 'MZ' },
    { label: 'Nagaland', value: 'NL' },
    { label: 'Odisha', value: 'OR' },
    { label: 'Punjab', value: 'PB' },
    { label: 'Rajasthan', value: 'RJ' },
    { label: 'Sikkim', value: 'SK' },
    { label: 'Tamil Nadu', value: 'TN' },
    { label: 'Telangana', value: 'TG' },
    { label: 'Tripura', value: 'TR' },
    { label: 'Uttar Pradesh', value: 'UP' },
    { label: 'Uttarakhand', value: 'UT' },
    { label: 'West Bengal', value: 'WB' },
    { label: 'Delhi', value: 'DL' },
    { label: 'Jammu & Kashmir', value: 'JK' },
    { label: 'Ladakh', value: 'LA' },
];

export const getCountryByCode = (code: string) => COUNTRIES.find(c => c.value === code);
export const getCurrency = (countryCode: string) => getCountryByCode(countryCode)?.currency || 'USD';
export const getTimezone = (countryCode: string) => getCountryByCode(countryCode)?.timezone || 'UTC';