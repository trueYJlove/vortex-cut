import React, { useState, useEffect } from "react";
import { useAssemblyService } from "../hooks/useAssemblyService";
import { VersionComparisonView } from "./VersionComparisonView";
import { SuggestionCard } from "./SuggestionCard";
import { TimelineSlider } from "./TimelineSlider";

interface ShotRequirementTimelineAssemblyPanelProps {
  assemblyId: string;
  projectId: string;
}

export const ShotRequirementTimelineAssemblyPanel = ({ 
  assemblyId,
  projectId
}: ShotRequirementTimelineAssemblyPanelProps) => {
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [comparisonVersion, setComparisonVersion] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<any[]>([]);
  
  const { getAssemblyHistory, compareAssemblyVersions } = useAssemblyService();
  
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const history = await getAssemblyHistory(assemblyId);
        setHistoryEntries(history);
        if (history.length > 0) {
          setSelectedVersion(history[0].id);
        }
      } catch (error) {
        console.error("Failed to load assembly history", error);
      }
    };
    
    fetchHistory();
  }, [assemblyId]);
  
  const handleVersionSelect = (versionId: string) => {
    if (!comparisonVersion) {
      setSelectedVersion(versionId);
    } else {
      // If comparison mode is active
      if (versionId === selectedVersion) {
        setComparisonVersion(null);
      } else {
        setComparisonVersion(versionId);
      }
    }
  };
  
  const handleCompareToggle = () => {
    if (selectedVersion && comparisonVersion) {
      setComparisonVersion(null);
    } else if (selectedVersion && historyEntries.length > 1) {
      // Find the previous version for comparison
      const currentIndex = historyEntries.findIndex(v => v.id === selectedVersion);
      const prevIndex = Math.min(currentIndex + 1, historyEntries.length - 1);
      setComparisonVersion(historyEntries[prevIndex].id);
    }
  };
  
  const renderComparison = () => {
    if (!selectedVersion || !comparisonVersion) return null;
    
    return (
      <VersionComparisonView 
        versionId1={selectedVersion} 
        versionId2={comparisonVersion} 
      />
    );
  };
  
  const renderSuggestions = () => {
    // In a real implementation, this would fetch suggestions based on context
    return (
      <div className="mt-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">
          Smart Suggestions
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SuggestionCard 
            title="Reuse Previous Shot" 
            description="This shot composition was successfully used in version 3"
            confidence={0.85}
            onClick={() => {/* Apply suggestion */}}
          />
          <SuggestionCard 
            title="Add Transition Effect" 
            description="Smooth transition recommended based on previous successful edits"
            confidence={0.72}
            onClick={() => {/* Apply suggestion */}}
          />
        </div>
      </div>
    );
  };
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-4">
          Assembly History
        </h2>
        
        <div className="flex justify-between items-center mb-4">
          <button
            onClick={handleCompareToggle}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              comparisonVersion 
                ? "bg-indigo-100 text-indigo-700 hover:bg-indigo-200" 
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {comparisonVersion ? "Exit Comparison Mode" : "Compare Versions"}
          </button>
          
          <span className="text-sm text-gray-500">
            {historyEntries.length} versions
          </span>
        </div>
        
        <TimelineSlider 
          versions={historyEntries}
          selectedVersion={selectedVersion}
          comparisonVersion={comparisonVersion}
          onVersionSelect={handleVersionSelect}
        />
      </div>
      
      {renderComparison()}
      
      {selectedVersion && !comparisonVersion && (
        <div className="mt-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            Current Version Details
          </h3>
          <div className="bg-white shadow overflow-hidden sm:rounded-lg">
            <div className="px-4 py-5 sm:px-6">
              <dl className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2">
                <div className="sm:col-span-1">
                  <dt className="text-sm font-medium text-gray-500">
                    Created
                  </dt>
                  <dd className="mt-1 text-sm text-gray-900">
                    {selectedVersion && 
                      new Date(historyEntries.find(v => v.id === selectedVersion)?.created_at).toLocaleString()}
                  </dd>
                </div>
                <div className="sm:col-span-1">
                  <dt className="text-sm font-medium text-gray-500">
                    Editor
                  </dt>
                  <dd className="mt-1 text-sm text-gray-900">
                    {selectedVersion && historyEntries.find(v => v.id === selectedVersion)?.user_id}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      )}
      
      {renderSuggestions()}
    </div>
  );
};
