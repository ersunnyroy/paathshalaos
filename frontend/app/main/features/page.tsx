'use client';

import { useState, useEffect } from 'react';
import { InputSwitch } from 'primereact/inputswitch';
import { moduleService, featureService } from '@/services/api';

interface Module {
    id: number;
    name: string;
    slug: string;
    description?: string;
    is_core: number;
    features?: Feature[];
}

interface Feature {
    id: number;
    module_id: number;
    name: string;
    slug: string;
    description?: string;
    is_default_enabled: number;
}

export default function FeaturesPage() {
    const [modules, setModules] = useState<Module[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const response = await moduleService.getAll();
            if (response.success && response.data) {
                setModules(response.data as Module[]);
            }
        } catch (error) {
            console.error('Error loading modules:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleFeatureToggle = async (featureId: number, isEnabled: boolean) => {
        try {
            await featureService.toggle(featureId, isEnabled);
        } catch (error) {
            console.error('Error toggling feature:', error);
        }
    };

    if (loading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen">
                <i className="pi pi-spin pi-spinner text-4xl" />
            </div>
        );
    }

    return (
        <div className="surface-card p-4 shadow-2 border-round">
            <h2 className="text-xl font-medium mb-4">Modules & Features</h2>

            <div className="flex flex-column gap-4">
                {modules.map((moduleItem) => (
                    <div key={moduleItem.id} className="surface-50 p-3 border-round">
                        <div className="flex align-items-center justify-content-between mb-3">
                            <div>
                                <div className="text-lg font-medium">{moduleItem.name}</div>
                                <div className="text-500 text-sm">{moduleItem.description}</div>
                            </div>
                            <span className={moduleItem.is_core ? 'bg-blue-100 text-blue-600 px-2 py-1 border-round text-sm' : 'text-500 text-sm'}>
                                {moduleItem.is_core ? 'Core' : 'Optional'}
                            </span>
                        </div>

                        {moduleItem.features && moduleItem.features.length > 0 && (
                            <div className="grid">
                                {moduleItem.features.map((feature) => (
                                    <div key={feature.id} className="col-12 md:col-6 flex align-items-center justify-content-between p-2">
                                        <div>
                                            <div className="font-medium">{feature.name}</div>
                                            <div className="text-500 text-sm">{feature.description}</div>
                                        </div>
                                        <InputSwitch
                                            checked={feature.is_default_enabled === 1}
                                            onChange={(e) => handleFeatureToggle(feature.id, e.value)}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}