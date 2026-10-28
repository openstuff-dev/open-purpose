import { bootstrapApplication } from '@angular/platform-browser';
import { loadPolyfills } from '@openstuff-dev/ui/polyfills';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Popovers, interestfor and anchor positioning where the browser lacks them.
void loadPolyfills();
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
