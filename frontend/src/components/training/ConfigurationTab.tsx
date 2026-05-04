import React from 'react';
import EssentialsCard from './config/EssentialsCard';
import AdvancedCard from './config/AdvancedCard';
import { ConfigComponentProps } from './types';
import { DatasetItem } from '@/lib/replayApi';

interface ConfigurationTabProps extends ConfigComponentProps {
  datasets: DatasetItem[];
  datasetsLoading: boolean;
}

const ConfigurationTab: React.FC<ConfigurationTabProps> = ({ config, updateConfig, datasets, datasetsLoading }) => {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <EssentialsCard
        config={config}
        updateConfig={updateConfig}
        datasets={datasets}
        datasetsLoading={datasetsLoading}
      />
      <AdvancedCard config={config} updateConfig={updateConfig} />
    </div>
  );
};

export default ConfigurationTab;
