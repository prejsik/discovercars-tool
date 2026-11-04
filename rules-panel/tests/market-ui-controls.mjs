export async function openMarketFilters(page) {
 const toggle=page.getByRole('button',{name:/^Filtry rynku:/});
 if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
}
