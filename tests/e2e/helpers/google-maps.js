export async function installGoogleMapsStub(page) {
  await page.addInitScript(() => {
    class Overlay {
      constructor(options) { this.options = options; this.map = options.map; }
      setMap(map) { this.map = map; }
    }
    class MapStub {
      constructor(element, options) { this.element = element; this.options = options; }
      fitBounds() {}
    }
    class LatLngBoundsStub {
      constructor() { this.points = []; }
      extend(point) { this.points.push(point); }
      isEmpty() { return this.points.length === 0; }
    }
    window.google = { maps: {
      Map: MapStub,
      Marker: Overlay,
      Circle: Overlay,
      Polyline: Overlay,
      LatLngBounds: LatLngBoundsStub,
      SymbolPath: { FORWARD_CLOSED_ARROW: 1 },
    } };
  });
}
