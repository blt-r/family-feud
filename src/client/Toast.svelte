<script>
  let { toast } = $props();
</script>

<div class="sr-only" role="status" aria-live="polite">{toast?.message || ""}</div>
{#if toast}
  {#key toast.id}
    <div class="toast" aria-hidden="true">{toast.message}</div>
  {/key}
{/if}
