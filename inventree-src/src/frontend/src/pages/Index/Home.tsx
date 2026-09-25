import { t } from '@lingui/core/macro';
import PageTitle from '../../components/nav/PageTitle';
import StationeryDashboard from '../../components/stationery/StationeryDashboard';

// The stationery product UI replaces InvenTree's generic configurable
// widget dashboard as the primary landing experience (per
// docs/superpowers/plans/2026-09-21-stationery-product-ui.md §2/§15) —
// this app's home page is the business dashboard, not a widget picker.
export default function Home() {
  return (
    <>
      <PageTitle title={t`Dashboard`} />
      <StationeryDashboard />
    </>
  );
}
