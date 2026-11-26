import { useEffect } from 'react';
import { DevicesModal } from './components/DevicesModal';
import { MainMenu } from './components/MainMenu';
import { RideScreen } from './components/RideScreen';
import { RideSummaryModal } from './components/RideSummaryModal';
import { SavedRidesModal } from './components/SavedRidesModal';
import { SettingsModal } from './components/SettingsModal';
import { WorkoutLibrary } from './components/WorkoutLibrary';
import { useAppStore } from './store/useAppStore';

export default function App() {
  const screen = useAppStore((s) => s.screen);
  const activeModal = useAppStore((s) => s.activeModal);
  const initSession = useAppStore((s) => s.initSession);

  useEffect(() => {
    initSession();
  }, [initSession]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#060412] text-slate-100">
      {screen === 'menu' && <MainMenu />}
      {screen === 'library' && <WorkoutLibrary />}
      {screen === 'ride' && <RideScreen />}

      {activeModal === 'devices' && <DevicesModal />}
      {activeModal === 'settings' && <SettingsModal />}
      {activeModal === 'summary' && <RideSummaryModal />}
      {activeModal === 'rides' && <SavedRidesModal />}
    </div>
  );
}
