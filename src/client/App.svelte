<script>
  import DisplayPage from "./DisplayPage.svelte";
  import HostPage from "./HostPage.svelte";

  const isHostPage = location.pathname === "/host" || location.pathname === "/host/";
</script>

{#if isHostPage}
  <HostPage />
{:else}
  <DisplayPage />
{/if}
