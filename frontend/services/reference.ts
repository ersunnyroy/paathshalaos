import { apiRoutes } from '@/lib/apiRoutes';
import { api } from './api';

export interface Country {
    id: number;
    name: string;
    code: string;
    currency: string;
    currency_symbol?: string;
    timezone: string;
    flag?: string;
}

export interface State {
    id: number;
    country_id: number;
    name: string;
    code: string;
    timezone?: string;
}

export interface InstituteType {
    id: number;
    name: string;
    slug: string;
    category?: string;
}

export interface Board {
    id: number;
    country_id?: number;
    name: string;
    slug: string;
    code?: string;
}

export interface Medium {
    id: number;
    name: string;
    slug: string;
}

export const referenceService = {
    async getCountries(): Promise<Country[]> {
        const response = await api.get<Country[]>(apiRoutes.references.countries());
        return response.data || [];
    },

    async getStates(countryId?: number): Promise<State[]> {
        const response = await api.get<State[]>(apiRoutes.references.states(countryId));
        return response.data || [];
    },

    async getInstituteTypes(): Promise<InstituteType[]> {
        const response = await api.get<InstituteType[]>(apiRoutes.references.instituteTypes());
        return response.data || [];
    },

    async getBoards(countryId?: number): Promise<Board[]> {
        const response = await api.get<Board[]>(apiRoutes.references.boards(countryId));
        return response.data || [];
    },

    async getMediums(): Promise<Medium[]> {
        const response = await api.get<Medium[]>(apiRoutes.references.mediums());
        return response.data || [];
    },

    async getAll() {
        const [countries, instituteTypes, mediums] = await Promise.all([
            this.getCountries(),
            this.getInstituteTypes(),
            this.getMediums(),
        ]);

        return { countries, instituteTypes, mediums };
    },
};

export const getCountryDefaults = (countries: Country[], countryCode: string) => {
    const country = countries.find(c => c.code === countryCode);
    return {
        timezone: country?.timezone || 'UTC',
        currency: country?.currency || 'USD',
    };
};