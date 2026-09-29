import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';

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
import { getLocalStorefrontSlug } from './lib/storefront-host';

const queryClient = new QueryClient();

function NotFound() {
  return (
    <div className="h-full flex flex-col items-center justify-center p-4 text-center">
      <h2 className="text-2xl font-extrabold mb-2">Page Not Found</h2>
      <p className="text-muted-foreground font-medium text-sm">The page you're looking for doesn't exist.</p>
    </div>
  );
}

class RuntimeErrorBoundary extends Component<{children:ReactNode},{error:Error|null}> {
  state={error:null as Error|null};
  static getDerivedStateFromError(error:Error){return {error};}
  componentDidCatch(error:Error,info:ErrorInfo){console.error('Relay storefront render error',error,info);}
  render(){return this.state.error?<div className="flex min-h-screen items-center justify-center bg-background p-6"><div role="alert" className="max-w-lg rounded-2xl border border-red-200 bg-red-50 p-6 text-red-900"><h1 className="text-xl font-extrabold">Relay could not render this page</h1><p className="mt-2 text-sm">The page hit an unexpected error. Reload to try again.</p><button type="button" onClick={()=>window.location.reload()} className="mt-4 rounded-xl bg-ink px-4 py-2 text-sm font-bold text-white">Reload</button></div></div>:this.props.children;}
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

function OwnerStorefrontRoute(){
  const {businessSlug}=useParams<{businessSlug:string}>();
  return <Storefront businessSlug={businessSlug}/>;
}

function AuthenticatedApp() {
  const {user,loading}=useAuth();
  const [,navigate]=useLocation();
  useEffect(()=>{if(!loading&&!user)navigate('/login');},[loading,user,navigate]);
  if(loading)return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading Relay…</div>;
  if(!user)return <Login />;
  return <Shell>
    <Switch>
      <Route path="/dashboard" component={Home} />
      <Route path="/customers" component={Customers} />
      <Route path="/marketing" component={Marketing} />
      <Route path="/shop" component={Orders} />
      <Route path="/commerce" component={StoreOverview} />
      <Route path="/commerce/products/new" component={Orders} />
      <Route path="/commerce/products" component={Orders} />
      <Route path="/commerce/orders" component={Orders} />
      <Route path="/ecommerce/storefront" component={StorefrontManagement} />
      <Route path="/ecommerce/storefront/:section" component={StorefrontManagement} />
      <Route path="/commerce/templates" component={StorefrontManagement} />
      <Route path="/more" component={More} />
      <Route component={NotFound} />
    </Switch>
  </Shell>;
}

function App() {
  const hostnameTenant=getLocalStorefrontSlug(window.location.hostname);
  return (
    <RuntimeErrorBoundary><QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          {hostnameTenant ? <Storefront tenantSlug={hostnameTenant}/> : <Switch>
            <Route path="/" component={Login} />
            <Route path="/login" component={Login} />
            <Route path="/onboarding/complete" component={ProtectedSetupComplete} />
            <Route path="/onboarding" component={OnboardingRoute} />
            <Route path="/store/:businessSlug" component={OwnerStorefrontRoute} />
            <Route path="/store/:businessSlug/:rest*" component={OwnerStorefrontRoute} />
            <Route path="/s/:businessSlug" component={OwnerStorefrontRoute} />
            <Route path="/s/:businessSlug/:rest*" component={OwnerStorefrontRoute} />
            <Route><AuthenticatedApp /></Route>
          </Switch>}
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider></RuntimeErrorBoundary>
  );
}

export default App;
