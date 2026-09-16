import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

import { Shell } from './components/layout/Shell';
import Home from './pages/Home';
import Customers from './pages/Customers';
import Marketing from './pages/Marketing';
import Orders from './pages/Shop';
import More from './pages/More';
import Login from './pages/login';
import SetupWizard from './pages/setup/SetupWizard';
import SetupComplete from './pages/setup/SetupComplete';
import Storefront from './pages/Storefront';
import StorefrontManagement from './pages/StorefrontManagement';
import StoreOverview from './sections/commerce/StoreOverview';
import { useAuth } from './hooks/useAuth';

const queryClient = new QueryClient();

function NotFound() {
  return (
    <div className="h-full flex flex-col items-center justify-center p-4 text-center">
      <h2 className="text-2xl font-extrabold mb-2">Page Not Found</h2>
      <p className="text-muted-foreground font-medium text-sm">The page you're looking for doesn't exist.</p>
    </div>
  );
}

function OnboardingRoute() {
  const {user,loading}=useAuth();
  if(loading)return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading Relay…</div>;
  return user?<SetupWizard />:<Login />;
}

function ProtectedSetupComplete(){
  const {user,loading}=useAuth();
  if(loading)return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading Relay…</div>;
  return user?<SetupComplete />:<Login />;
}

function AuthenticatedApp() {
  const {user,loading}=useAuth();
  const [,navigate]=useLocation();
  useEffect(()=>{if(!loading&&!user)navigate('/login');},[loading,user,navigate]);
  if(loading)return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading Relay…</div>;
  if(!user)return null;
  return <Shell>
    <Switch>
      <Route path="/dashboard" component={Home} />
      <Route path="/customers" component={Customers} />
      <Route path="/marketing" component={Marketing} />
      <Route path="/shop" component={Orders} />
      <Route path="/commerce" component={StoreOverview} />
      <Route path="/ecommerce/storefront" component={StorefrontManagement} />
      <Route path="/ecommerce/storefront/:section" component={StorefrontManagement} />
      <Route path="/more" component={More} />
      <Route component={NotFound} />
    </Switch>
  </Shell>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Switch>
            <Route path="/" component={Login} />
            <Route path="/login" component={Login} />
            <Route path="/onboarding/complete" component={ProtectedSetupComplete} />
            <Route path="/onboarding" component={OnboardingRoute} />
            <Route path="/store/:businessSlug" component={Storefront} />
            <Route path="/store/:businessSlug/:rest*" component={Storefront} />
            <Route><AuthenticatedApp /></Route>
          </Switch>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
